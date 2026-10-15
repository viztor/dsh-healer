/**
 * Conventional Commits, enforced on the commit message itself.
 *
 * The repository already writes messages this way; this makes it a rule rather
 * than a habit. `release` is added to the stock type list because this project
 * cuts its own releases by rewriting history into one commit, and that commit is
 * neither a `feat` nor a `chore`.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'release',
        'revert',
        'style',
        'test',
      ],
    ],
    // A body is where the reasoning lives; this repository's commits carry it.
    'body-max-line-length': [0, 'always'],
    // The subject is a sentence, not a headline — sentence case reads better and
    // the stock rule fights the way these messages are already written.
    'subject-case': [0, 'always'],
    'header-max-length': [2, 'always', 100],
  },
};
