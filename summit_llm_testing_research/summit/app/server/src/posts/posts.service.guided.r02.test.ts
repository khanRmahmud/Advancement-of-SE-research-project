import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../errors/app.error.js';
import { HttpStatus } from '../errors/http-status.js';
import { ErrorCode } from '../errors/error-code.js';

type PostFixture = { authorId: number };

const getByIdPostMock = mock.fn(
  async (_postId: number): Promise<PostFixture | null> => null,
);
const removePostMock = mock.fn(
  async (_postId: number): Promise<void> => undefined,
);

function unexpectedDependency(): never {
  throw new Error('Unexpected dependency call during post deletion');
}

mock.module('./posts.repositories.js', {
  namedExports: {
    createPost: unexpectedDependency,
    getAllPosts: unexpectedDependency,
    getByIdPost: getByIdPostMock,
    getCommunityById: unexpectedDependency,
    getPostVote: unexpectedDependency,
    removePost: removePostMock,
    setPostVote: unexpectedDependency,
    updatePost: unexpectedDependency,
  },
});

mock.module('./posts.mapper.js', {
  namedExports: {
    toPostContract: unexpectedDependency,
  },
});

const { removePostService } = await import('./posts.service.js');

function resetMocks(): void {
  getByIdPostMock.mock.resetCalls();
  removePostMock.mock.resetCalls();
  getByIdPostMock.mock.mockImplementation(async () => null);
  removePostMock.mock.mockImplementation(async () => undefined);
}

function assertLookupCalls(...postIds: number[]): void {
  assert.deepEqual(
    getByIdPostMock.mock.calls.map((call) => call.arguments),
    postIds.map((postId) => [postId]),
  );
}

function assertRemovalCalls(...postIds: number[]): void {
  assert.deepEqual(
    removePostMock.mock.calls.map((call) => call.arguments),
    postIds.map((postId) => [postId]),
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('an existing post can be deleted by its author', { concurrency: false }, async () => {
  resetMocks();
  getByIdPostMock.mock.mockImplementation(async () => ({ authorId: 12 }));

  const response = await removePostService(41, 12);

  assert.deepEqual(response, { success: true });
  assertLookupCalls(41);
  assertRemovalCalls(41);
});

test('another user receives a forbidden error and cannot delete the post', { concurrency: false }, async () => {
  resetMocks();
  getByIdPostMock.mock.mockImplementation(async () => ({ authorId: 12 }));

  await assert.rejects(removePostService(41, 99), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.deepEqual(
      error,
      new AppError(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        "You cannot delete another user's post.",
      ),
    );
    return true;
  });

  assertLookupCalls(41);
  assertRemovalCalls();
});

test('a missing post produces a not-found error without attempting deletion', { concurrency: false }, async () => {
  resetMocks();

  await assert.rejects(removePostService(404, 12), (error: unknown) => {
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
  });

  assertLookupCalls(404);
  assertRemovalCalls();
});

test('a lookup failure is propagated without attempting deletion', { concurrency: false }, async () => {
  resetMocks();
  const failure = new Error('Post lookup failed');
  getByIdPostMock.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(removePostService(41, 12), (error: unknown) => {
    assert.strictEqual(error, failure);
    return true;
  });

  assertLookupCalls(41);
  assertRemovalCalls();
});

test('a deletion failure is propagated rather than reported as success', { concurrency: false }, async () => {
  resetMocks();
  const failure = new Error('Post deletion failed');
  getByIdPostMock.mock.mockImplementation(async () => ({ authorId: 12 }));
  removePostMock.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(removePostService(41, 12), (error: unknown) => {
    assert.strictEqual(error, failure);
    return true;
  });

  assertLookupCalls(41);
  assertRemovalCalls(41);
});

test('deletion waits for the post lookup to establish ownership', { concurrency: false }, async () => {
  resetMocks();
  const lookup = deferred<PostFixture | null>();
  getByIdPostMock.mock.mockImplementation(() => lookup.promise);

  const operation = removePostService(73, 24);

  try {
    assertLookupCalls(73);
    assertRemovalCalls();
  } finally {
    lookup.resolve({ authorId: 24 });
  }

  assert.deepEqual(await operation, { success: true });
  assertLookupCalls(73);
  assertRemovalCalls(73);
});

test('success is not returned until the repository finishes deleting the post', { concurrency: false }, async () => {
  resetMocks();
  const deletionStarted = deferred<void>();
  const deletionFinished = deferred<void>();
  getByIdPostMock.mock.mockImplementation(async () => ({ authorId: 24 }));
  removePostMock.mock.mockImplementation(async () => {
    deletionStarted.resolve(undefined);
    await deletionFinished.promise;
  });

  let settled = false;
  const operation = removePostService(73, 24).then(
    (response) => {
      settled = true;
      return response;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );

  await deletionStarted.promise;

  try {
    assert.equal(settled, false);
    assertLookupCalls(73);
    assertRemovalCalls(73);
  } finally {
    deletionFinished.resolve(undefined);
  }

  assert.deepEqual(await operation, { success: true });
  assert.equal(settled, true);
  assertRemovalCalls(73);
});

test('ownership is determined by matching identifiers even when the author identifier is zero', { concurrency: false }, async () => {
  resetMocks();
  getByIdPostMock.mock.mockImplementation(async () => ({ authorId: 0 }));

  const response = await removePostService(57, 0);

  assert.deepEqual(response, { success: true });
  assertLookupCalls(57);
  assertRemovalCalls(57);
});
