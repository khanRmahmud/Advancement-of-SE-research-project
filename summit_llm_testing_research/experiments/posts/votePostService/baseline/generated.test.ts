import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../errors/app.error.js';
import { HttpStatus } from '../errors/http-status.js';
import { ErrorCode } from '../errors/error-code.js';
import type { PostVoteResponse } from '@summit/shared';

const postId = 42;
const userId = 17;

const getByIdPost = mock.fn(
  async (_postId: number): Promise<unknown> => ({ id: postId, vote: 10 }),
);
const setPostVote = mock.fn(
  async (
    _postId: number,
    _userId: number,
    _value: number,
  ): Promise<PostVoteResponse | null> => ({ votes: 11, userVote: 1 }),
);

function unexpectedDependency(): never {
  throw new Error('Unexpected dependency call');
}

mock.module('./posts.repositories.js', {
  namedExports: {
    createPost: unexpectedDependency,
    getAllPosts: unexpectedDependency,
    getByIdPost,
    getCommunityById: unexpectedDependency,
    getPostVote: unexpectedDependency,
    removePost: unexpectedDependency,
    setPostVote,
    updatePost: unexpectedDependency,
  },
});

mock.module('./posts.mapper.js', {
  namedExports: {
    toPostContract: unexpectedDependency,
  },
});

const { votePostService } = await import('./posts.service.js');

beforeEach(() => {
  getByIdPost.mock.resetCalls();
  setPostVote.mock.resetCalls();

  getByIdPost.mock.mockImplementation(async () => ({ id: postId, vote: 10 }));
  setPostVote.mock.mockImplementation(async () => ({
    votes: 11,
    userVote: 1,
  }));
});

function assertLookup(): void {
  assert.equal(getByIdPost.mock.callCount(), 1);
  assert.deepEqual(getByIdPost.mock.calls[0]!.arguments, [postId]);
}

function assertVoteWrite(value: number): void {
  assert.equal(setPostVote.mock.callCount(), 1);
  assert.deepEqual(setPostVote.mock.calls[0]!.arguments, [
    postId,
    userId,
    value,
  ]);
}

function assertPostNotFound(error: unknown): boolean {
  assert.ok(error instanceof AppError);
  assert.deepEqual(
    error,
    new AppError(
      HttpStatus.NOT_FOUND,
      ErrorCode.POST_NOT_FOUND,
      'Post not found.',
    ),
  );
  return true;
}

test('votePostService forwards an upvote and returns the repository response unchanged', async () => {
  const response: PostVoteResponse = { votes: 11, userVote: 1 };
  setPostVote.mock.mockImplementation(async () => response);

  const result = await votePostService(postId, userId, { value: 1 });

  assert.strictEqual(result, response);
  assertLookup();
  assertVoteWrite(1);
});

test('votePostService forwards a downvote and preserves a negative vote total', async () => {
  const response: PostVoteResponse = { votes: -3, userVote: -1 };
  setPostVote.mock.mockImplementation(async () => response);

  const result = await votePostService(postId, userId, { value: -1 });

  assert.deepEqual(result, { votes: -3, userVote: -1 });
  assertLookup();
  assertVoteWrite(-1);
});

test('votePostService forwards zero to clear a vote and preserves zero-valued results', async () => {
  const response: PostVoteResponse = { votes: 0, userVote: 0 };
  setPostVote.mock.mockImplementation(async () => response);

  const result = await votePostService(postId, userId, { value: 0 });

  assert.deepEqual(result, { votes: 0, userVote: 0 });
  assertLookup();
  assertVoteWrite(0);
});

test('votePostService rejects a missing post without attempting a vote write', async () => {
  getByIdPost.mock.mockImplementation(async () => null);

  await assert.rejects(
    votePostService(postId, userId, { value: 1 }),
    assertPostNotFound,
  );

  assertLookup();
  assert.equal(setPostVote.mock.callCount(), 0);
});

test('votePostService reports post not found when the vote write returns null', async () => {
  setPostVote.mock.mockImplementation(async () => null);

  await assert.rejects(
    votePostService(postId, userId, { value: -1 }),
    assertPostNotFound,
  );

  assertLookup();
  assertVoteWrite(-1);
});

test('votePostService propagates lookup failures without attempting a vote write', async () => {
  const failure = new Error('Post lookup failed');
  getByIdPost.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(
    votePostService(postId, userId, { value: 1 }),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assertLookup();
  assert.equal(setPostVote.mock.callCount(), 0);
});

test('votePostService propagates vote-write failures unchanged', async () => {
  const failure = new Error('Vote write failed');
  setPostVote.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(
    votePostService(postId, userId, { value: 0 }),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assertLookup();
  assertVoteWrite(0);
});

test('votePostService waits for the post lookup before writing the vote', async () => {
  let resolveLookup!: (post: unknown) => void;
  const pendingLookup = new Promise<unknown>((resolve) => {
    resolveLookup = resolve;
  });
  getByIdPost.mock.mockImplementation(() => pendingLookup);

  const response: PostVoteResponse = { votes: 6, userVote: 1 };
  setPostVote.mock.mockImplementation(async () => response);

  const pendingVote = votePostService(postId, userId, { value: 1 });

  assertLookup();
  assert.equal(setPostVote.mock.callCount(), 0);

  resolveLookup({ id: postId, vote: 5 });

  assert.strictEqual(await pendingVote, response);
  assertLookup();
  assertVoteWrite(1);
});
