import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../errors/app.error.js';
import { HttpStatus } from '../errors/http-status.js';
import { ErrorCode } from '../errors/error-code.js';

const getByIdPost = mock.fn(
  async (_postId: number): Promise<unknown> => undefined,
);
const createComment = mock.fn(
  async (
    _postId: number,
    _userId: number,
    _body: string,
    _parentId: number | null,
    _isAnonymous: boolean,
  ): Promise<unknown> => undefined,
);
const toCommentContract = mock.fn((_comment: unknown): unknown => undefined);

function unexpectedRepositoryCall(): never {
  throw new Error('Unexpected repository call');
}

mock.module('./comments.repositories.js', {
  namedExports: {
    createComment,
    getByIdPost,
    getCommentsByPostId: unexpectedRepositoryCall,
    getCommentById: unexpectedRepositoryCall,
    getCommentVote: unexpectedRepositoryCall,
    removeCommentById: unexpectedRepositoryCall,
    setCommentVote: unexpectedRepositoryCall,
    updateCommentById: unexpectedRepositoryCall,
  },
});

mock.module('./comments.mapper.js', {
  namedExports: { toCommentContract },
});

const { createCommentService } = await import('./comments.services.js');

function setup() {
  getByIdPost.mock.resetCalls();
  createComment.mock.resetCalls();
  toCommentContract.mock.resetCalls();

  const postId = 23;
  const userId = 47;
  const body = 'A comment on this post.';
  const savedComment = {
    id: 91,
    postId,
    authorId: userId,
    body,
    parentId: null,
    isAnonymous: false,
  };
  const mappedComment = {
    id: savedComment.id,
    body: savedComment.body,
  };

  getByIdPost.mock.mockImplementation(async () => ({ id: postId }));
  createComment.mock.mockImplementation(async () => savedComment);
  toCommentContract.mock.mockImplementation(() => mappedComment);

  return { postId, userId, body, savedComment, mappedComment };
}

test('creates a non-anonymous top-level comment and returns its mapped contract', { concurrency: false }, async () => {
  const { postId, userId, body, savedComment, mappedComment } = setup();

  const result = await createCommentService(postId, userId, {
    body,
    isAnonymous: false,
  });

  assert.deepEqual(result, { comment: mappedComment });
  assert.strictEqual(result.comment, mappedComment);
  assert.equal(getByIdPost.mock.callCount(), 1);
  assert.deepEqual(getByIdPost.mock.calls[0]!.arguments, [postId]);
  assert.equal(createComment.mock.callCount(), 1);
  assert.deepEqual(createComment.mock.calls[0]!.arguments, [
    postId,
    userId,
    body,
    null,
    false,
  ]);
  assert.equal(toCommentContract.mock.callCount(), 1);
  assert.strictEqual(
    toCommentContract.mock.calls[0]!.arguments[0],
    savedComment,
  );
});

test('passes anonymous creation through while retaining the submitting user ID', { concurrency: false }, async () => {
  const { postId, userId, body, savedComment, mappedComment } = setup();
  const anonymousComment = { ...savedComment, isAnonymous: true };
  createComment.mock.mockImplementation(async () => anonymousComment);

  const result = await createCommentService(postId, userId, {
    body,
    isAnonymous: true,
  });

  assert.deepEqual(result, { comment: mappedComment });
  assert.equal(getByIdPost.mock.callCount(), 1);
  assert.deepEqual(getByIdPost.mock.calls[0]!.arguments, [postId]);
  assert.equal(createComment.mock.callCount(), 1);
  assert.deepEqual(createComment.mock.calls[0]!.arguments, [
    postId,
    userId,
    body,
    null,
    true,
  ]);
  assert.equal(toCommentContract.mock.callCount(), 1);
  assert.strictEqual(
    toCommentContract.mock.calls[0]!.arguments[0],
    anonymousComment,
  );
});

test('forwards an empty body unchanged without adding service-level validation', { concurrency: false }, async () => {
  const { postId, userId, savedComment, mappedComment } = setup();
  const emptyComment = { ...savedComment, body: '' };
  createComment.mock.mockImplementation(async () => emptyComment);

  const result = await createCommentService(postId, userId, {
    body: '',
    isAnonymous: false,
  });

  assert.deepEqual(result, { comment: mappedComment });
  assert.equal(createComment.mock.callCount(), 1);
  assert.deepEqual(createComment.mock.calls[0]!.arguments, [
    postId,
    userId,
    '',
    null,
    false,
  ]);
  assert.equal(toCommentContract.mock.callCount(), 1);
  assert.strictEqual(
    toCommentContract.mock.calls[0]!.arguments[0],
    emptyComment,
  );
});

test('rejects a missing post without saving or mapping a comment', { concurrency: false }, async () => {
  const { postId, userId, body } = setup();
  getByIdPost.mock.mockImplementation(async () => null);

  await assert.rejects(
    createCommentService(postId, userId, { body, isAnonymous: false }),
    new AppError(
      HttpStatus.NOT_FOUND,
      ErrorCode.POST_NOT_FOUND,
      'Post not found.',
    ),
  );

  assert.equal(getByIdPost.mock.callCount(), 1);
  assert.deepEqual(getByIdPost.mock.calls[0]!.arguments, [postId]);
  assert.equal(createComment.mock.callCount(), 0);
  assert.equal(toCommentContract.mock.callCount(), 0);
});

test('propagates a post lookup failure without attempting persistence', { concurrency: false }, async () => {
  const { postId, userId, body } = setup();
  const failure = new Error('Post lookup failed');
  getByIdPost.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(
    createCommentService(postId, userId, { body, isAnonymous: false }),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assert.equal(getByIdPost.mock.callCount(), 1);
  assert.deepEqual(getByIdPost.mock.calls[0]!.arguments, [postId]);
  assert.equal(createComment.mock.callCount(), 0);
  assert.equal(toCommentContract.mock.callCount(), 0);
});

test('propagates a persistence failure without mapping a comment', { concurrency: false }, async () => {
  const { postId, userId, body } = setup();
  const failure = new Error('Comment persistence failed');
  createComment.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(
    createCommentService(postId, userId, { body, isAnonymous: false }),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assert.equal(getByIdPost.mock.callCount(), 1);
  assert.equal(createComment.mock.callCount(), 1);
  assert.deepEqual(createComment.mock.calls[0]!.arguments, [
    postId,
    userId,
    body,
    null,
    false,
  ]);
  assert.equal(toCommentContract.mock.callCount(), 0);
});

test('propagates a mapping failure after saving without retrying persistence', { concurrency: false }, async () => {
  const { postId, userId, body, savedComment } = setup();
  const failure = new Error('Comment mapping failed');
  toCommentContract.mock.mockImplementation(() => {
    throw failure;
  });

  await assert.rejects(
    createCommentService(postId, userId, { body, isAnonymous: false }),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assert.equal(getByIdPost.mock.callCount(), 1);
  assert.equal(createComment.mock.callCount(), 1);
  assert.equal(toCommentContract.mock.callCount(), 1);
  assert.strictEqual(
    toCommentContract.mock.calls[0]!.arguments[0],
    savedComment,
  );
});

test('waits for post lookup and persistence before mapping the saved comment', { concurrency: false }, async () => {
  const { postId, userId, body, savedComment, mappedComment } = setup();

  let resolvePost!: (value: unknown) => void;
  let resolveComment!: (value: unknown) => void;
  let notifyCreation!: () => void;

  const postLookup = new Promise<unknown>((resolve) => {
    resolvePost = resolve;
  });
  const persistence = new Promise<unknown>((resolve) => {
    resolveComment = resolve;
  });
  const creationStarted = new Promise<void>((resolve) => {
    notifyCreation = resolve;
  });

  getByIdPost.mock.mockImplementation(() => postLookup);
  createComment.mock.mockImplementation(() => {
    notifyCreation();
    return persistence;
  });

  const pending = createCommentService(postId, userId, {
    body,
    isAnonymous: false,
  });

  try {
    assert.equal(getByIdPost.mock.callCount(), 1);
    assert.deepEqual(getByIdPost.mock.calls[0]!.arguments, [postId]);
    assert.equal(createComment.mock.callCount(), 0);
    assert.equal(toCommentContract.mock.callCount(), 0);

    resolvePost({ id: postId });
    await creationStarted;

    assert.equal(createComment.mock.callCount(), 1);
    assert.deepEqual(createComment.mock.calls[0]!.arguments, [
      postId,
      userId,
      body,
      null,
      false,
    ]);
    assert.equal(toCommentContract.mock.callCount(), 0);

    resolveComment(savedComment);
    const result = await pending;

    assert.deepEqual(result, { comment: mappedComment });
    assert.equal(toCommentContract.mock.callCount(), 1);
    assert.strictEqual(
      toCommentContract.mock.calls[0]!.arguments[0],
      savedComment,
    );
  } finally {
    resolvePost({ id: postId });
    resolveComment(savedComment);
    await pending;
  }
});
