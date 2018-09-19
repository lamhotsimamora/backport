import { getCommitsByAuthor, setAccessToken } from '../src/lib/github';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

describe('getCommitsByAuthor', () => {
  it('should return commits with pull request', async () => {
    const mock = new MockAdapter(axios);
    const owner = 'elastic';
    const repoName = 'kibana';
    const accessToken = 'myAccessToken';
    const author = 'sqren';
    const commitSha = 'myCommitSha';
    setAccessToken(accessToken);

    mock
      .onGet(
        `https://api.github.com/repos/${owner}/${repoName}/commits?access_token=${accessToken}&per_page=5&author=${author}`
      )
      .reply(200, [
        {
          commit: {
            message: 'myMessage'
          },
          sha: commitSha
        }
      ]);

    mock
      .onGet(
        `https://api.github.com/search/issues?q=repo:${owner}/${repoName}+${commitSha}+base:master&access_token=${accessToken}`
      )
      .reply(200, {
        items: [
          {
            number: 'myPullRequestNumber'
          }
        ]
      });

    expect(await getCommitsByAuthor(owner, repoName, author)).toEqual([
      {
        message: 'myMessage',
        pullNumber: 'myPullRequestNumber',
        sha: 'myCommitSha'
      }
    ]);
  });

  it('should return commits without pull request', async () => {
    const mock = new MockAdapter(axios);
    const owner = 'elastic';
    const repoName = 'kibana';
    const accessToken = 'myAccessToken';
    const author = 'sqren';
    const commitSha = 'myCommitSha';
    setAccessToken(accessToken);

    mock
      .onGet(
        `https://api.github.com/repos/${owner}/${repoName}/commits?access_token=${accessToken}&per_page=5&author=${author}`
      )
      .reply(200, [
        {
          commit: {
            message: 'myMessage'
          },
          sha: commitSha
        }
      ]);

    mock
      .onGet(
        `https://api.github.com/search/issues?q=repo:${owner}/${repoName}+${commitSha}+base:master&access_token=${accessToken}`
      )
      .reply(200, { items: [] });

    expect(await getCommitsByAuthor(owner, repoName, author)).toEqual([
      {
        message: 'myMessage',
        pullNumber: undefined,
        sha: 'myCommitSha'
      }
    ]);
  });
});
