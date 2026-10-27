#!/usr/bin/env bash
# Idempotent deploy: DynamoDB + Lambda (API + 5-min reminder cron) + S3/CloudFront site at $DOMAIN.
# First run creates everything; later runs update the Lambda code and site files.
# Usage: infra/deploy.sh (first run: PASSWORD='...' VAPID_EMAIL=you@example.com infra/deploy.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=yenstudy
REGION=us-west-2
DOMAIN=yenstudy.ckearl.com
ZONE_NAME=ckearl.com
TABLE=$NAME
BUCKET=$NAME-ckearl-web
ROLE=$NAME-lambda
FN=$NAME-api
RULE=$NAME-reminders
SECRETS=infra/.secrets.env

export AWS_REGION=$REGION AWS_PAGER=""
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---------- secrets (generated once, kept out of git) ----------
# First run: PASSWORD='...' infra/deploy.sh — only the scrypt hash is stored. Pass PASSWORD again later to change it.
if [[ ! -f $SECRETS ]]; then
  : "${PASSWORD:?Set PASSWORD for the first deploy, e.g. PASSWORD='...' infra/deploy.sh}"
  : "${VAPID_EMAIL:?Set VAPID_EMAIL (contact address push services see) for the first deploy}"
  log "Generating VAPID keys"
  KEYS=$(cd api && node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log(k.publicKey+' '+k.privateKey)")
  printf 'VAPID_PUBLIC=%s\nVAPID_PRIVATE=%s\nVAPID_SUBJECT=mailto:%s\n' "${KEYS% *}" "${KEYS#* }" "$VAPID_EMAIL" > $SECRETS
  chmod 600 $SECRETS
fi
if [[ ${PASSWORD:-} ]]; then
  log "Setting password hash"
  sed -i '' '/^PASSWORD_HASH=/d;/^PASSCODE=/d' $SECRETS
  echo "PASSWORD_HASH='$(node api/hash-password.mjs "$PASSWORD")'" >> $SECRETS
fi
# CALENDAR_URL='https://calendar.google.com/calendar/ical/.../basic.ics' infra/deploy.sh — her class calendar's secret address.
if [[ ${CALENDAR_URL:-} ]]; then
  log "Saving calendar address"
  sed -i '' '/^CALENDAR_URL=/d' $SECRETS
  echo "CALENDAR_URL='$CALENDAR_URL'" >> $SECRETS
fi
# shellcheck disable=SC1090
source $SECRETS

# ---------- DynamoDB ----------
if ! aws dynamodb describe-table --table-name $TABLE >/dev/null 2>&1; then
  log "Creating DynamoDB table $TABLE (free-tier provisioned 5/5)"
  aws dynamodb create-table --table-name $TABLE \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5 \
    --deletion-protection-enabled >/dev/null
  aws dynamodb wait table-exists --table-name $TABLE
fi
# Expired login tokens clean themselves up (they're rejected either way).
if [[ $(aws dynamodb describe-time-to-live --table-name $TABLE --query TimeToLiveDescription.TimeToLiveStatus --output text) == DISABLED ]]; then
  aws dynamodb update-time-to-live --table-name $TABLE --time-to-live-specification Enabled=true,AttributeName=ttl >/dev/null \
    || echo "!! Could not enable TTL"
fi
TABLE_ARN=arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE

# ---------- IAM role ----------
if ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  log "Creating IAM role $ROLE"
  aws iam create-role --role-name $ROLE --assume-role-policy-document '{
    "Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 10 # IAM propagation
fi
aws iam put-role-policy --role-name $ROLE --policy-name dynamodb --policy-document "{
  \"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",
  \"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:UpdateItem\",\"dynamodb:DeleteItem\",\"dynamodb:Query\"],
  \"Resource\":\"$TABLE_ARN\"}]}"
ROLE_ARN=arn:aws:iam::$ACCOUNT:role/$ROLE

# ---------- Lambda ----------
log "Building Lambda bundle"
rm -rf build && mkdir -p build/api
cp api/index.mjs api/config.mjs api/package.json api/package-lock.json build/api/
(cd build/api && npm ci --omit=dev --silent && zip -qr ../api.zip .)
ENV="Variables={TABLE=$TABLE,PASSWORD_HASH=$PASSWORD_HASH,VAPID_PUBLIC=$VAPID_PUBLIC,VAPID_PRIVATE=$VAPID_PRIVATE,VAPID_SUBJECT=$VAPID_SUBJECT${CALENDAR_URL:+,CALENDAR_URL=$CALENDAR_URL}}"
if aws lambda get-function --function-name $FN >/dev/null 2>&1; then
  log "Updating Lambda $FN"
  aws lambda update-function-code --function-name $FN --zip-file fileb://build/api.zip >/dev/null
  aws lambda wait function-updated --function-name $FN
  aws lambda update-function-configuration --function-name $FN --environment "$ENV" >/dev/null
  aws lambda wait function-updated --function-name $FN
else
  log "Creating Lambda $FN"
  aws lambda create-function --function-name $FN --runtime nodejs22.x --architectures arm64 \
    --handler index.handler --role "$ROLE_ARN" --zip-file fileb://build/api.zip \
    --memory-size 256 --timeout 15 --environment "$ENV" >/dev/null
  aws lambda wait function-active --function-name $FN
fi
FN_ARN=$(aws lambda get-function --function-name $FN --query Configuration.FunctionArn --output text)

# Function URL (CloudFront proxies /api/* to it; the app checks the passcode header).
if ! aws lambda get-function-url-config --function-name $FN >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name $FN --auth-type NONE >/dev/null
  aws lambda add-permission --function-name $FN --statement-id url-public --action lambda:InvokeFunctionUrl \
    --principal '*' --function-url-auth-type NONE >/dev/null
  aws lambda add-permission --function-name $FN --statement-id url-invoke --action lambda:InvokeFunction \
    --principal '*' --invoked-via-function-url >/dev/null 2>&1 || true
fi
FN_URL_HOST=$(aws lambda get-function-url-config --function-name $FN --query FunctionUrl --output text | sed -E 's#https://([^/]+)/?#\1#')

# ---------- reminder cron (every 5 minutes) ----------
# Needs events:PutRule / events:PutTargets on the deploying IAM user.
if RULE_ARN=$(aws events put-rule --name $RULE --schedule-expression 'rate(5 minutes)' --query RuleArn --output text 2>/dev/null); then
  aws events put-targets --rule $RULE --targets "Id=fn,Arn=$FN_ARN,Input='{\"task\":\"cron\"}'" >/dev/null
  aws lambda add-permission --function-name $FN --statement-id events-cron --action lambda:InvokeFunction \
    --principal events.amazonaws.com --source-arn "$RULE_ARN" >/dev/null 2>&1 || true
else
  CRON_SKIPPED=1
  printf '\n\033[33m!! Skipped reminder cron: this IAM user lacks events:PutRule. Grant it and re-run.\033[0m\n'
fi

# ---------- S3 bucket (private) ----------
if ! aws s3api head-bucket --bucket $BUCKET >/dev/null 2>&1; then
  log "Creating bucket $BUCKET"
  aws s3api create-bucket --bucket $BUCKET --create-bucket-configuration LocationConstraint=$REGION >/dev/null
  aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

# ---------- TLS certificate (us-east-1 for CloudFront) ----------
ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name $ZONE_NAME --query "HostedZones[0].Id" --output text | sed 's#/hostedzone/##')
CERT_ARN=$(aws acm list-certificates --region us-east-1 --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text)
if [[ $CERT_ARN == None ]]; then
  log "Requesting certificate for $DOMAIN"
  CERT_ARN=$(aws acm request-certificate --region us-east-1 --domain-name $DOMAIN --validation-method DNS --query CertificateArn --output text)
  sleep 8
fi
if [[ $(aws acm describe-certificate --region us-east-1 --certificate-arn "$CERT_ARN" --query Certificate.Status --output text) != ISSUED ]]; then
  log "Validating certificate via Route53"
  read -r RR_NAME RR_VALUE < <(aws acm describe-certificate --region us-east-1 --certificate-arn "$CERT_ARN" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord.[Name,Value]' --output text)
  aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",
    \"ResourceRecordSet\":{\"Name\":\"$RR_NAME\",\"Type\":\"CNAME\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$RR_VALUE\"}]}}]}" >/dev/null
  aws acm wait certificate-validated --region us-east-1 --certificate-arn "$CERT_ARN"
fi

# ---------- CloudFront ----------
# Legacy Origin Access Identity (this IAM user can't create OACs).
OAI_ID=$(aws cloudfront list-cloud-front-origin-access-identities --query "CloudFrontOriginAccessIdentityList.Items[?Comment=='$NAME'].Id | [0]" --output text)
if [[ $OAI_ID == None || -z $OAI_ID ]]; then
  OAI_ID=$(aws cloudfront create-cloud-front-origin-access-identity \
    --cloud-front-origin-access-identity-config CallerReference=$NAME-oai,Comment=$NAME --query CloudFrontOriginAccessIdentity.Id --output text)
fi
DIST_ID=$(aws cloudfront list-distributions --query "DistributionList.Items[?Aliases.Items && contains(Aliases.Items, '$DOMAIN')].Id | [0]" --output text)
if [[ $DIST_ID == None ]]; then
  log "Creating CloudFront distribution"
  # Managed policies: CachingOptimized, CachingDisabled, AllViewerExceptHostHeader
  cat > build/dist.json <<EOF
{
  "CallerReference": "$NAME-$(date +%s)",
  "Aliases": {"Quantity": 1, "Items": ["$DOMAIN"]},
  "DefaultRootObject": "index.html",
  "Comment": "Study tracker",
  "Enabled": true,
  "HttpVersion": "http2and3",
  "PriceClass": "PriceClass_100",
  "Origins": {"Quantity": 2, "Items": [
    {"Id": "web", "DomainName": "$BUCKET.s3.$REGION.amazonaws.com",
     "S3OriginConfig": {"OriginAccessIdentity": "origin-access-identity/cloudfront/$OAI_ID"}},
    {"Id": "api", "DomainName": "$FN_URL_HOST",
     "CustomOriginConfig": {"HTTPPort": 80, "HTTPSPort": 443, "OriginProtocolPolicy": "https-only",
       "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]}}}
  ]},
  "DefaultCacheBehavior": {
    "TargetOriginId": "web", "ViewerProtocolPolicy": "redirect-to-https", "Compress": true,
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
    "AllowedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"], "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}}
  },
  "CacheBehaviors": {"Quantity": 1, "Items": [{
    "PathPattern": "/api/*", "TargetOriginId": "api", "ViewerProtocolPolicy": "https-only", "Compress": true,
    "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    "AllowedMethods": {"Quantity": 7, "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
      "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}}
  }]},
  "ViewerCertificate": {"ACMCertificateArn": "$CERT_ARN", "SSLSupportMethod": "sni-only", "MinimumProtocolVersion": "TLSv1.2_2021"}
}
EOF
  DIST_ID=$(aws cloudfront create-distribution --distribution-config file://build/dist.json --query Distribution.Id --output text)
fi
DIST_DOMAIN=$(aws cloudfront get-distribution --id "$DIST_ID" --query Distribution.DomainName --output text)

aws s3api put-bucket-policy --bucket $BUCKET --policy "{
  \"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity $OAI_ID\"},
  \"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\"}]}"

# ---------- DNS ----------
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "{\"Changes\":[
  {\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$DOMAIN\",\"Type\":\"A\",\"AliasTarget\":{\"HostedZoneId\":\"Z2FDTNDATAQYW2\",\"DNSName\":\"$DIST_DOMAIN\",\"EvaluateTargetHealth\":false}}},
  {\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$DOMAIN\",\"Type\":\"AAAA\",\"AliasTarget\":{\"HostedZoneId\":\"Z2FDTNDATAQYW2\",\"DNSName\":\"$DIST_DOMAIN\",\"EvaluateTargetHealth\":false}}}
]}" >/dev/null

# ---------- site files ----------
log "Uploading site"
aws s3 sync web/ s3://$BUCKET/ --delete --cache-control "no-cache" >/dev/null
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' >/dev/null

log "Done → https://$DOMAIN"
[[ ${CRON_SKIPPED:-} ]] && echo "   (reminder cron NOT set up — see warning above)" || true
