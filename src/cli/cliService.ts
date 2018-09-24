import { Commit, BranchChoice, GithubPullRequestPayload } from '../types/types';

import chalk from 'chalk';
import isEmpty from 'lodash.isempty';
import ora from 'ora';

import {
  listCommits,
  listBranches,
  confirmConflictResolved
} from '../lib/prompts';
import * as github from '../lib/github';
import { HandledError } from '../lib/errors';
import { getRepoPath } from '../lib/env';
import * as logger from '../lib/logger';

import {
  resetBranch,
  cherrypick,
  createAndCheckoutBranch,
  push,
  repoExists,
  deleteRepo,
  setupRepo,
  isIndexDirty,
  verifyGithubSshAuth
} from '../lib/git';

export function doBackportVersions(
  owner: string,
  repoName: string,
  commits: Commit[],
  branches: string[],
  username: string,
  labels: string[]
) {
  return sequentially(branches, async (baseBranch: string) => {
    try {
      const pullRequest = await doBackportVersion(
        owner,
        repoName,
        commits,
        baseBranch,
        username,
        labels
      );
      logger.log(`View pull request: ${pullRequest.html_url}\n`);
    } catch (e) {
      handleErrors(e);
    }
  });
}

export function handleErrors(e: Error) {
  switch (e.name) {
    // Handled exceptions
    case 'HandledError':
      console.error(e.message);
      break;

    // Unhandled exceptions
    default:
      console.error(e);
      throw e;
  }
}

export async function doBackportVersion(
  owner: string,
  repoName: string,
  commits: Commit[],
  baseBranch: string,
  username: string,
  labels: string[] = []
) {
  const featureBranch = getFeatureBranchName(baseBranch, commits);
  const refValues = commits.map(commit => getReferenceLong(commit)).join(', ');
  logger.log(`Backporting ${refValues} to ${baseBranch}`);

  await withSpinner({ text: 'Pulling latest changes' }, async () => {
    await resetBranch(owner, repoName);
    await createAndCheckoutBranch(owner, repoName, baseBranch, featureBranch);
  });

  await sequentially(commits, commit =>
    cherrypickAndConfirm(owner, repoName, commit.sha)
  );

  await withSpinner(
    { text: `Pushing branch ${username}:${featureBranch}` },
    () => push(owner, repoName, username, featureBranch)
  );

  return withSpinner({ text: 'Creating pull request' }, async () => {
    const payload = getPullRequestPayload(baseBranch, commits, username);
    const pullRequest = await github.createPullRequest(
      owner,
      repoName,
      payload
    );
    if (labels.length > 0) {
      await github.addLabels(owner, repoName, pullRequest.number, labels);
    }
    return pullRequest;
  });
}

export async function maybeSetupRepo(
  owner: string,
  repoName: string,
  username: string
) {
  await verifyGithubSshAuth();

  if (await repoExists(owner, repoName)) {
    return;
  }

  const text = 'Cloning repository (only first time)';
  const spinner = ora(`0% ${text}`).start();

  try {
    await setupRepo(owner, repoName, username, (progress: string) => {
      spinner.text = `${progress}% ${text}`;
    });
    spinner.succeed();
  } catch (e) {
    spinner.stop();
    await deleteRepo(owner, repoName);
    throw e;
  }
}

export async function getCommitBySha(
  owner: string,
  repoName: string,
  sha: string
) {
  const spinner = ora().start();
  try {
    const commit = await github.getCommitBySha(owner, repoName, sha);
    spinner.stopAndPersist({
      symbol: chalk.green('?'),
      text: `${chalk.bold('Select commit')} ${chalk.cyan(commit.message)}`
    });
    return commit;
  } catch (e) {
    spinner.stop();
    throw e;
  }
}

export async function getCommitByPullNumber(
  owner: string,
  repoName: string,
  pullNumber: number
) {
  const spinner = ora().start();
  try {
    const commit = await github.getCommitByPullNumber(
      owner,
      repoName,
      pullNumber
    );
    spinner.stopAndPersist({
      symbol: chalk.green('?'),
      text: `${chalk.bold('Select commit')} ${chalk.cyan(commit.message)}`
    });
    return commit;
  } catch (e) {
    spinner.stop();
    throw e;
  }
}

export async function getCommitsByPrompt(
  owner: string,
  repoName: string,
  author: string | null,
  multipleCommits: boolean
) {
  const spinner = ora('Loading commits...').start();
  try {
    const commits = await github.getCommitsByAuthor(owner, repoName, author);
    if (isEmpty(commits)) {
      spinner.stopAndPersist({
        symbol: chalk.green('?'),
        text: `${chalk.bold('Select commit')} `
      });

      throw new HandledError(
        chalk.red(
          author
            ? 'There are no commits by you in this repository'
            : 'There are no commits in this repository'
        )
      );
    }
    spinner.stop();
    return listCommits(commits, multipleCommits);
  } catch (e) {
    spinner.fail();
    throw e;
  }
}

export function getBranchesByPrompt(
  branches: BranchChoice[],
  isMultipleChoice = false
) {
  return listBranches(branches, isMultipleChoice);
}

function sequentially<T>(items: T[], handler: (item: T) => Promise<any>) {
  return items.reduce(async (p, item) => {
    await p;
    return handler(item);
  }, Promise.resolve());
}

function getFeatureBranchName(baseBranch: string, commits: Commit[]) {
  const refValues = commits
    .map(commit => getReferenceShort(commit))
    .join('_')
    .slice(0, 200);
  return `backport/${baseBranch}/${refValues}`;
}

function getShortSha(commit: Commit) {
  return commit.sha.slice(0, 7);
}

export function getReferenceLong(commit: Commit) {
  return commit.pullNumber ? `#${commit.pullNumber}` : getShortSha(commit);
}

function getReferenceShort(commit: Commit) {
  return commit.pullNumber
    ? `pr-${commit.pullNumber}`
    : `commit-${getShortSha(commit)}`;
}

async function cherrypickAndConfirm(
  owner: string,
  repoName: string,
  sha: string
) {
  try {
    await withSpinner(
      {
        text: 'Cherry-picking commit',
        errorText: `Cherry-picking failed. Please resolve conflicts in: ${getRepoPath(
          owner,
          repoName
        )}`
      },
      () => cherrypick(owner, repoName, sha)
    );
  } catch (e) {
    const hasConflict = e.cmd.includes('git cherry-pick');
    if (!hasConflict) {
      throw e;
    }

    await confirmResolvedRecursive(owner, repoName);
  }
}

async function confirmResolvedRecursive(owner: string, repoName: string) {
  const res = await confirmConflictResolved();
  if (!res) {
    throw new HandledError('Application was aborted.');
  }

  const isDirty = await isIndexDirty(owner, repoName);
  if (isDirty) {
    await confirmResolvedRecursive(owner, repoName);
  }
}

function getPullRequestTitle(baseBranch: string, commits: Commit[]) {
  const commitMessages = commits
    .map(commit => commit.message)
    .join(' | ')
    .slice(0, 200);

  return `[${baseBranch}] ${commitMessages}`;
}

function getPullRequestPayload(
  baseBranch: string,
  commits: Commit[],
  username: string
): GithubPullRequestPayload {
  const featureBranch = getFeatureBranchName(baseBranch, commits);
  const commitRefs = commits
    .map(commit => {
      const ref = getReferenceLong(commit);
      return ` - ${commit.message.replace(`(${ref})`, '')} (${ref})`;
    })
    .join('\n');

  return {
    title: getPullRequestTitle(baseBranch, commits),
    body: `Backports the following commits to ${baseBranch}:\n${commitRefs}`,
    head: `${username}:${featureBranch}`,
    base: `${baseBranch}`
  };
}

async function withSpinner<T>(
  { text, errorText }: { text?: string; errorText?: string },
  fn: () => Promise<T>
): Promise<T> {
  const spinner = ora(text).start();

  try {
    const res = await fn();
    if (text) {
      spinner.succeed();
    } else {
      spinner.stop();
    }

    return res;
  } catch (e) {
    if (errorText) {
      spinner.text = errorText;
    }
    spinner.fail();
    throw e;
  }
}