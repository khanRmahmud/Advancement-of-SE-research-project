import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../errors/app.error.js';
import { HttpStatus } from '../errors/http-status.js';
import { ErrorCode } from '../errors/error-code.js';
import type { DatabaseComment } from './comments.mapper.js';

type CommentContract = ReturnType<
  typeof import('./comments.mapper.js').toCommentContract
>;

const commentId = 41;
const userId = 7;

function makeComment(
  overrides: Record<string, unknown> = {},
): DatabaseComment {
  return {
    id: commentId,
    postId: 12,
    authorId: userId,
    parentId: null,
    body: 'Original body',
    isAnonymous: false,
    deletedAt: null,
    ...overrides,
  } as unknown as DatabaseComment;
}

const existingComment = makeComment();
const updatedComment = makeComment({ body: 'Updated body' });
const mappedComment = {
  id: commentId,
  body: 'Updated body',
} as unknown as CommentContract;

const events: string[] = [];

const getCommentById = mock.fn(
  async (_id: number): Promise<DatabaseComment | null> => {
    events.push('lookup');
    return existingComment;
  },
);

const updateCommentById = mock.fn(
  async (_id: number, _body: string): Promise<DatabaseComment> => {
    events.push('update');
    return updatedComment;
  },
);

const toCommentContract = mock.fn(
  (_comment: DatabaseComment): CommentContract => {
    events.push('map');
    return mappedComment;
  },
);

const unexpectedRepositoryCall = (): never => {
  throw new Error('Unexpected repository call');
};

mock.module('./comments.repositories.js', {
  namedExports: {
    createComment: unexpectedRepositoryCall,
    getByIdPost: unexpectedRepositoryCall,
    getCommentsByPostId: unexpectedRepositoryCall,
    getCommentById,
    getCommentVote: unexpectedRepositoryCall,
    removeCommentById: unexpectedRepositoryCall,
    setCommentVote: unexpectedRepositoryCall,
    updateCommentById,
  },
});

mock.module('./comments.mapper.js', {
  namedExports: { toCommentContract },
});

// Execute with Node's --experimental-test-module-mocks flag.
const { updateCommentService } = await import('./comments.services.js');

function resetMocks(): void {
  events.length = 0;

  getCommentById.mock.resetCalls();
  getCommentById.mock.mockImplementation(async () => {
    events.push('lookup');
    return existingComment;
  });

  updateCommentById.mock.resetCalls();
  updateCommentById.mock.mockImplementation(async () => {
    events.push('update');
    return updatedComment;
  });

  toCommentContract.mock.resetCalls();
  toCommentContract.mock.mockImplementation(() => {
    events.push('map');
    return mappedComment;
  });
}

function assertLookupOnly(): void {
  assert.equal(getCommentById.mock.callCount(), 1);
  assert.deepEqual(getCommentById.mock.calls[0]!.arguments, [commentId]);
  assert.equal(updateCommentById.mock.callCount(), 0);
  assert.equal(toCommentContract.mock.callCount(), 0);
}

test('updateCommentService updates an owned comment and maps the repository result', { concurrency: false }, async () => {
  resetMocks();

  const result = await updateCommentService(commentId, userId, {
    body: 'Updated body',
  });

  assert.deepEqual(result, { comment: mappedComment });
  assert.strictEqual(result.comment, mappedComment);
  assert.equal(getCommentById.mock.callCount(), 1);
  assert.deepEqual(getCommentById.mock.calls[0]!.arguments, [commentId]);
  assert.equal(updateCommentById.mock.callCount(), 1);
  assert.deepEqual(updateCommentById.mock.calls[0]!.arguments, [
    commentId,
    'Updated body',
  ]);
  assert.equal(toCommentContract.mock.callCount(), 1);
  assert.strictEqual(
    toCommentContract.mock.calls[0]!.arguments[0],
    updatedComment,
  );
  assert.deepEqual(events, ['lookup', 'update', 'map']);
});

test('updateCommentService forwards an empty body without service-level validation', { concurrency: false }, async () => {
  resetMocks();
  const emptyComment = makeComment({ body: '' });
  updateCommentById.mock.mockImplementation(async () => emptyComment);

  const result = await updateCommentService(commentId, userId, { body: '' });

  assert.deepEqual(result, { comment: mappedComment });
  assert.equal(getCommentById.mock.callCount(), 1);
  assert.deepEqual(getCommentById.mock.calls[0]!.arguments, [commentId]);
  assert.equal(updateCommentById.mock.callCount(), 1);
  assert.deepEqual(updateCommentById.mock.calls[0]!.arguments, [commentId, '']);
  assert.equal(toCommentContract.mock.callCount(), 1);
  assert.strictEqual(
    toCommentContract.mock.calls[0]!.arguments[0],
    emptyComment,
  );
});

test('updateCommentService rejects a missing comment without updating or mapping', { concurrency: false }, async () => {
  resetMocks();
  getCommentById.mock.mockImplementation(async () => null);

  await assert.rejects(
    updateCommentService(commentId, userId, { body: 'Updated body' }),
    new AppError(
      HttpStatus.NOT_FOUND,
      ErrorCode.COMMENT_NOT_FOUND,
      'Comment not found.',
    ),
  );

  assertLookupOnly();
});

test('updateCommentService rejects a comment owned by another user', { concurrency: false }, async () => {
  resetMocks();
  getCommentById.mock.mockImplementation(async () =>
    makeComment({ authorId: userId + 1 }),
  );

  await assert.rejects(
    updateCommentService(commentId, userId, { body: 'Updated body' }),
    new AppError(
      HttpStatus.FORBIDDEN,
      ErrorCode.FORBIDDEN,
      "You cannot modify another user's comment.",
    ),
  );

  assertLookupOnly();
});

test('updateCommentService rejects an owned comment that has been deleted', { concurrency: false }, async () => {
  resetMocks();
  getCommentById.mock.mockImplementation(async () =>
    makeComment({ deletedAt: new Date('2025-01-01T00:00:00.000Z') }),
  );

  await assert.rejects(
    updateCommentService(commentId, userId, { body: 'Updated body' }),
    new AppError(
      HttpStatus.CONFLICT,
      ErrorCode.COMMENT_DELETED,
      'This comment has already been deleted.',
    ),
  );

  assertLookupOnly();
});

test('updateCommentService checks ownership before reporting deletion', { concurrency: false }, async () => {
  resetMocks();
  getCommentById.mock.mockImplementation(async () =>
    makeComment({
      authorId: userId + 1,
      deletedAt: new Date('2025-01-01T00:00:00.000Z'),
    }),
  );

  await assert.rejects(
    updateCommentService(commentId, userId, { body: 'Updated body' }),
    new AppError(
      HttpStatus.FORBIDDEN,
      ErrorCode.FORBIDDEN,
      "You cannot modify another user's comment.",
    ),
  );

  assertLookupOnly();
});

test('updateCommentService propagates lookup failures without attempting an update', { concurrency: false }, async () => {
  resetMocks();
  const failure = new Error('Comment lookup failed');
  getCommentById.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(
    updateCommentService(commentId, userId, { body: 'Updated body' }),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assertLookupOnly();
});

test('updateCommentService propagates update failures without mapping a result', { concurrency: false }, async () => {
  resetMocks();
  const failure = new Error('Comment update failed');
  updateCommentById.mock.mockImplementation(async () => {
    events.push('update');
    throw failure;
  });

  await assert.rejects(
    updateCommentService(commentId, userId, { body: 'Updated body' }),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assert.equal(getCommentById.mock.callCount(), 1);
  assert.deepEqual(getCommentById.mock.calls[0]!.arguments, [commentId]);
  assert.equal(updateCommentById.mock.callCount(), 1);
  assert.deepEqual(updateCommentById.mock.calls[0]!.arguments, [
    commentId,
    'Updated body',
  ]);
  assert.equal(toCommentContract.mock.callCount(), 0);
  assert.deepEqual(events, ['lookup', 'update']);
});
