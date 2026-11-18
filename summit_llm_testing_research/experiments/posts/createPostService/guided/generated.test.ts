import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../errors/app.error.js';
import { HttpStatus } from '../errors/http-status.js';
import { ErrorCode } from '../errors/error-code.js';

// Run with Node.js's --experimental-test-module-mocks flag.
type Repositories = typeof import('./posts.repositories.js');
type Mapper = typeof import('./posts.mapper.js');
type CreateRequest = Parameters<
  typeof import('./posts.service.js')['createPostService']
>[0];
type Community = Awaited<ReturnType<Repositories['getCommunityById']>>;
type DatabasePost = Parameters<Mapper['toPostContract']>[0];
type PostContract = ReturnType<Mapper['toPostContract']>;

const community = Object.freeze({ id: 9 }) as unknown as Community;
const databasePost = Object.freeze({ id: 401 }) as unknown as DatabasePost;
const postContract = Object.freeze({ id: 401 }) as unknown as PostContract;

const getCommunityById = mock.fn(
  async (..._args: Parameters<Repositories['getCommunityById']>): Promise<Community> =>
    community,
);
const createPost = mock.fn(
  async (..._args: Parameters<Repositories['createPost']>) => databasePost,
);
const toPostContract = mock.fn(
  (_post: DatabasePost): PostContract => postContract,
);
const unexpectedRepositoryCall = mock.fn((): never => {
  throw new Error('Unexpected repository operation');
});

mock.module('./posts.repositories.js', {
  namedExports: {
    getCommunityById,
    createPost,
    getAllPosts: unexpectedRepositoryCall,
    getByIdPost: unexpectedRepositoryCall,
    getPostVote: unexpectedRepositoryCall,
    removePost: unexpectedRepositoryCall,
    setPostVote: unexpectedRepositoryCall,
    updatePost: unexpectedRepositoryCall,
  },
});

mock.module('./posts.mapper.js', {
  namedExports: { toPostContract },
});

const { createPostService } = await import('./posts.service.js');

function resetMocks(): void {
  getCommunityById.mock.mockImplementation(async () => community);
  createPost.mock.mockImplementation(async () => databasePost);
  toPostContract.mock.mockImplementation(() => postContract);

  getCommunityById.mock.resetCalls();
  createPost.mock.resetCalls();
  toPostContract.mock.resetCalls();
  unexpectedRepositoryCall.mock.resetCalls();
}

function request(overrides: Partial<CreateRequest> = {}): CreateRequest {
  return {
    title: 'A community update',
    body: 'Here is the content of the post.',
    communityId: 9,
    isAnonymous: false,
    ...overrides,
  };
}

test('creates a post with its content, selected community, author, and photo metadata', async () => {
  resetMocks();
  const data = request({
    photoUrl: 'https://example.test/photo.jpg',
    photoWidth: 1200,
    photoHeight: 800,
  });

  const result = await createPostService(data, 37);

  assert.deepEqual(getCommunityById.mock.calls.map(call => call.arguments), [
    [data.communityId],
  ]);
  assert.deepEqual(createPost.mock.calls.map(call => call.arguments), [
    [
      data.title,
      data.body,
      37,
      data.communityId,
      {
        photoUrl: data.photoUrl,
        photoWidth: data.photoWidth,
        photoHeight: data.photoHeight,
      },
      false,
    ],
  ]);
  assert.equal(toPostContract.mock.callCount(), 1);
  assert.strictEqual(toPostContract.mock.calls[0]!.arguments[0], databasePost);
  assert.deepEqual(result, { post: postContract });
  assert.strictEqual(result.post, postContract);
  assert.equal(unexpectedRepositoryCall.mock.callCount(), 0);
});

test('supports a text-only post when all optional photo fields are omitted', async () => {
  resetMocks();
  const data = request();
  assert.equal(Object.hasOwn(data, 'photoUrl'), false);
  assert.equal(Object.hasOwn(data, 'photoWidth'), false);
  assert.equal(Object.hasOwn(data, 'photoHeight'), false);

  const result = await createPostService(data, 38);

  assert.equal(getCommunityById.mock.callCount(), 1);
  assert.equal(createPost.mock.callCount(), 1);
  assert.deepEqual(createPost.mock.calls[0]!.arguments, [
    data.title,
    data.body,
    38,
    data.communityId,
    {
      photoUrl: undefined,
      photoWidth: undefined,
      photoHeight: undefined,
    },
    false,
  ]);
  assert.equal(toPostContract.mock.callCount(), 1);
  assert.strictEqual(result.post, postContract);
});

test('passes anonymous publication to persistence while retaining the creating user ID', async () => {
  resetMocks();
  const data = request({ isAnonymous: true, communityId: 24 });

  const result = await createPostService(data, 72);

  assert.deepEqual(getCommunityById.mock.calls[0]!.arguments, [24]);
  assert.equal(createPost.mock.callCount(), 1);
  assert.deepEqual(createPost.mock.calls[0]!.arguments, [
    data.title,
    data.body,
    72,
    24,
    {
      photoUrl: undefined,
      photoWidth: undefined,
      photoHeight: undefined,
    },
    true,
  ]);
  assert.strictEqual(toPostContract.mock.calls[0]!.arguments[0], databasePost);
  assert.strictEqual(result.post, postContract);
});

test('waits for community lookup to succeed before creating or mapping a post', async () => {
  resetMocks();
  let resolveLookup!: (value: Community) => void;
  const lookup = new Promise<Community>(resolve => {
    resolveLookup = resolve;
  });
  getCommunityById.mock.mockImplementation(() => lookup);
  const data = request();

  const pendingResult = createPostService(data, 37);

  assert.equal(getCommunityById.mock.callCount(), 1);
  assert.equal(createPost.mock.callCount(), 0);
  assert.equal(toPostContract.mock.callCount(), 0);

  resolveLookup(community);
  const result = await pendingResult;

  assert.equal(createPost.mock.callCount(), 1);
  assert.equal(toPostContract.mock.callCount(), 1);
  assert.strictEqual(result.post, postContract);
});

test('rejects a missing community with the specified not-found error without creating a post', async () => {
  resetMocks();
  getCommunityById.mock.mockImplementation(async () => null);
  const data = request({ communityId: 999 });

  await assert.rejects(
    createPostService(data, 37),
    new AppError(
      HttpStatus.NOT_FOUND,
      ErrorCode.COMMUNITY_NOT_FOUND,
      'Community not found.',
    ),
  );

  assert.deepEqual(getCommunityById.mock.calls.map(call => call.arguments), [
    [999],
  ]);
  assert.equal(createPost.mock.callCount(), 0);
  assert.equal(toPostContract.mock.callCount(), 0);
  assert.equal(unexpectedRepositoryCall.mock.callCount(), 0);
});

test('propagates a community lookup failure without attempting persistence or mapping', async () => {
  resetMocks();
  const failure = new Error('Community lookup failed');
  getCommunityById.mock.mockImplementation(async () => {
    throw failure;
  });
  const data = request();

  await assert.rejects(createPostService(data, 37), error => {
    assert.strictEqual(error, failure);
    return true;
  });

  assert.deepEqual(getCommunityById.mock.calls.map(call => call.arguments), [
    [data.communityId],
  ]);
  assert.equal(createPost.mock.callCount(), 0);
  assert.equal(toPostContract.mock.callCount(), 0);
});

test('propagates a persistence failure without mapping a nonexistent result', async () => {
  resetMocks();
  const failure = new Error('Post insert failed');
  createPost.mock.mockImplementation(async () => {
    throw failure;
  });
  const data = request();

  await assert.rejects(createPostService(data, 37), error => {
    assert.strictEqual(error, failure);
    return true;
  });

  assert.equal(getCommunityById.mock.callCount(), 1);
  assert.equal(createPost.mock.callCount(), 1);
  assert.deepEqual(createPost.mock.calls[0]!.arguments, [
    data.title,
    data.body,
    37,
    data.communityId,
    {
      photoUrl: undefined,
      photoWidth: undefined,
      photoHeight: undefined,
    },
    false,
  ]);
  assert.equal(toPostContract.mock.callCount(), 0);
});

test('propagates a contract-mapping failure after creating the post exactly once', async () => {
  resetMocks();
  const failure = new Error('Post mapping failed');
  toPostContract.mock.mockImplementation(() => {
    throw failure;
  });

  await assert.rejects(createPostService(request(), 37), error => {
    assert.strictEqual(error, failure);
    return true;
  });

  assert.equal(getCommunityById.mock.callCount(), 1);
  assert.equal(createPost.mock.callCount(), 1);
  assert.equal(toPostContract.mock.callCount(), 1);
  assert.strictEqual(toPostContract.mock.calls[0]!.arguments[0], databasePost);
  assert.equal(unexpectedRepositoryCall.mock.callCount(), 0);
});
