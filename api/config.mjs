// Seed config written to DynamoDB on first run. After that the app's Settings screen owns it.
export const TZ = 'America/Denver';

export const DEFAULT_CONFIG = {
  courses: [
    { id: 'torts', name: 'Torts', short: 'Torts', code: 'LAW 505' },
    { id: 'contracts', name: 'Contracts', short: 'Contracts', code: 'LAW 510' },
    { id: 'conlaw', name: 'Structures of the Constitution', short: 'ConLaw', code: 'LAW 530' },
    { id: 'lrw', name: 'Intro to Legal Research & Writing', short: 'LR&W', code: 'LAW 545' },
  ],
  // Extra choices under a card's "Other" button. She can add more in Settings or by typing.
  activities: ['Review session', 'Activity', 'Office hours', 'Outlining'],
  theme: 'blossom',
  reminder: { enabled: true, minutes: 150 }, // one push if a stopwatch runs this long without a pause
  themes: [],
  // Sample schedule; the real one is entered in Settings or read from the class calendar.
  semesters: [
    {
      id: 'fall-2026', name: 'Fall 2026', start: '2026-08-20', end: '2026-12-04',
      noClass: ['2026-09-07', '2026-11-25', '2026-11-26', '2026-11-27'],
      schedule: [
        { id: 'm-torts', course: 'torts', days: ['M', 'W'], start: '09:00', end: '10:30' },
        { id: 'm-contracts', course: 'contracts', days: ['M', 'W'], start: '13:00', end: '14:30' },
        { id: 'm-conlaw', course: 'conlaw', days: ['T', 'Th'], start: '10:00', end: '11:30' },
        { id: 'm-lrw', course: 'lrw', days: ['M', 'T', 'Th'], start: '08:00', end: '08:50' },
      ],
    },
    {
      id: 'winter-2027', name: 'Winter 2027', start: '2027-01-04', end: '2027-04-09',
      noClass: ['2027-01-18', '2027-02-15'],
      schedule: [],
    },
  ],
};
