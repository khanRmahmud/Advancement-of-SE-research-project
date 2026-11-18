import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../errors/app.error.js';
import { HttpStatus } from '../errors/http-status.js';
import { ErrorCode } from '../errors/error-code.js';

type PostFixture = { authorId: number };

function unexpectedCall(): never {
  throw new Error('Unexpected dependency call');
}

const getByIdPost = mock.fn(
  async (_postId: number): Promise<PostFixture | null> => ({ authorId: 7 }),
);
const removePost = mock.fn(async (_postId: number): Promise<void> => {});

const unrelatedRepositories = {
  createPost: mock.fn(unexpectedCall),
  getAllPosts: mock.fn(unexpectedCall),
  getCommunityById: mock.fn(unexpectedCall),
  getPostVote: mock.fn(unexpectedCall),
  setPostVote: mock.fn(unexpectedCall),
  updatePost: mock.fn(unexpectedCall),
};
const toPostContract = mock.fn(unexpectedCall);

// Run with Node's --experimental-test-module-mocks flag.
mock.module('./posts.repositories.js', {
  namedExports: {
    ...unrelatedRepositories,
    getByIdPost,
    removePost,
  },
});
mock.module('./posts.mapper.js', {
  namedExports: { toPostContract },
});

const { removePostService } = await import('./posts.service.js');

function setup(): void {
  getByIdPost.mock.resetCalls();
  getByIdPost.mock.mockImplementation(async () => ({ authorId: 7 }));
  removePost.mock.resetCalls();
  removePost.mock.mockImplementation(async () => {});

  for (const dependency of Object.values(unrelatedRepositories)) {
    dependency.mock.resetCalls();
  }
  toPostContract.mock.resetCalls();
}

function assertInteractions(
  expectedLookups: number[][],
  expectedDeletions: number[][],
): void {
  assert.deepEqual(
    getByIdPost.mock.calls.map((call) => call.arguments),
    expectedLookups,
  );
  assert.deepEqual(
    removePost.mock.calls.map((call) => call.arguments),
    expectedDeletions,
  );
  for (const dependency of Object.values(unrelatedRepositories)) {
    assert.equal(dependency.mock.callCount(), 0);
  }
  assert.equal(toPostContract.mock.callCount(), 0);
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

test('removePostService deletes an existing post owned by the caller', async () => {
  setup();

  const result = await removePostService(42, 7);

  assert.deepEqual(result, { success: true });
  assertInteractions([[42]], [[42]]);
});

test('removePostService permits matching zero-valued post and author IDs', async () => {
  setup();
  getByIdPost.mock.mockImplementation(async () => ({ authorId: 0 }));

  const result = await removePostService(0, 0);

  assert.deepEqual(result, { success: true });
  assertInteractions([[0]], [[0]]);
});

test('removePostService rejects a missing post without attempting deletion', async () => {
  setup();
  getByIdPost.mock.mockImplementation(async () => null);

  await assert.rejects(
    removePostService(404, 7),
    new AppError(
      HttpStatus.NOT_FOUND,
      ErrorCode.POST_NOT_FOUND,
      'Post not found.',
    ),
  );

  assertInteractions([[404]], []);
});

test("removePostService rejects deletion of another user's post", async () => {
  setup();

  await assert.rejects(
    removePostService(42, 8),
    new AppError(
      HttpStatus.FORBIDDEN,
      ErrorCode.FORBIDDEN,
      "You cannot delete another user's post.",
    ),
  );

  assertInteractions([[42]], []);
});

test('removePostService propagates lookup errors without attempting deletion', async () => {
  setup();
  const failure = new Error('Post lookup failed');
  getByIdPost.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(removePostService(42, 7), (error: unknown) => {
    assert.strictEqual(error, failure);
    return true;
  });

  assertInteractions([[42]], []);
});

test('removePostService propagates deletion errors instead of returning success', async () => {
  setup();
  const failure = new Error('Post deletion failed');
  removePost.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(removePostService(42, 7), (error: unknown) => {
    assert.strictEqual(error, failure);
    return true;
  });

  assertInteractions([[42]], [[42]]);
});

test('removePostService waits for lookup before authorizing and deleting', async () => {
  setup();
  const lookup = deferred<PostFixture | null>();
  getByIdPost.mock.mockImplementation(() => lookup.promise);
  let settled = false;

  const resultPromise = removePostService(42, 7);
  void resultPromise.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  try {
    await Promise.resolve();

    assert.equal(settled, false);
    assertInteractions([[42]], []);
  } finally {
    lookup.resolve({ authorId: 7 });
  }

  assert.deepEqual(await resultPromise, { success: true });
  assertInteractions([[42]], [[42]]);
});

test('removePostService waits for deletion to complete before returning success', async () => {
  setup();
  const deletion = deferred<void>();
  const deletionStarted = deferred<void>();
  removePost.mock.mockImplementation(() => {
    deletionStarted.resolve(undefined);
    return deletion.promise;
  });
  let settled = false;

  const resultPromise = removePostService(42, 7);
  void resultPromise.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  try {
    await deletionStarted.promise;
    await Promise.resolve();

    assert.equal(settled, false);
    assertInteractions([[42]], [[42]]);
  } finally {
    deletion.resolve(undefined);
  }

  assert.deepEqual(await resultPromise, { success: true });
  assertInteractions([[42]], [[42]]);
});
