// Prints a PASSWORD_HASH value for the Lambda env. Usage: node hash-password.mjs '<password>'
import { randomBytes, scryptSync } from 'node:crypto';

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`;
}
if (process.argv[1]?.endsWith('hash-password.mjs')) {
  if (!process.argv[2]) { console.error('usage: node hash-password.mjs <password>'); process.exit(1); }
  console.log(hashPassword(process.argv[2]));
}
