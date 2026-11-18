import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';

import { AppError } from '../errors/app.error.js';
import { ErrorCode } from '../errors/error-code.js';
import { HttpStatus } from '../errors/http-status.js';

type CommunityFixture = { id: number };

const getCommunityByNameMock = mock.fn(
  async (_name: string): Promise<CommunityFixture | undefined> => undefined,
);

const joinCommunityMock = mock.fn(
  async (_userId: number, _communityId: number): Promise<void> => {},
);

function unexpectedDependencyCall(): never {
  throw new Error('Unexpected dependency call');
}

mock.module('./communities.repositories.js', {
  namedExports: {
    createCommunity: unexpectedDependencyCall,
    getAllCommunities: unexpectedDependencyCall,
    getCommunityByName: getCommunityByNameMock,
    getCommunityPosts: unexpectedDependencyCall,
    getJoinedCommunities: unexpectedDependencyCall,
    joinCommunity: joinCommunityMock,
    leaveCommunity: unexpectedDependencyCall,
    updateCommunity: unexpectedDependencyCall,
  },
});

mock.module('./communities.mappers.js', {
  namedExports: {
    toCommunityContract: unexpectedDependencyCall,
  },
});

mock.module('../posts/posts.mapper.js', {
  namedExports: {
    toPostContract: unexpectedDependencyCall,
  },
});

const { joinCommunityService } = await import('./communities.services.js');

beforeEach(() => {
  getCommunityByNameMock.mock.resetCalls();
  getCommunityByNameMock.mock.mockImplementation(async () => undefined);

  joinCommunityMock.mock.resetCalls();
  joinCommunityMock.mock.mockImplementation(async () => {});
});

test('joins the resolved community and returns its membership response', async () => {
  const events: string[] = [];

  getCommunityByNameMock.mock.mockImplementation(async () => {
    events.push('lookup');
    return { id: 42 };
  });

  joinCommunityMock.mock.mockImplementation(async () => {
    events.push('join');
  });

  const result = await joinCommunityService('typescript', 17);

  assert.deepEqual(result, { communityId: 42, joined: true });
  assert.deepEqual(events, ['lookup', 'join']);
  assert.equal(getCommunityByNameMock.mock.callCount(), 1);
  assert.deepEqual(getCommunityByNameMock.mock.calls[0]!.arguments, [
    'typescript',
  ]);
  assert.equal(joinCommunityMock.mock.callCount(), 1);
  assert.deepEqual(joinCommunityMock.mock.calls[0]!.arguments, [17, 42]);
});

test('rejects a missing community with the specified AppError without joining', async () => {
  await assert.rejects(joinCommunityService('missing', 17), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.deepEqual(
      error,
      new AppError(
        HttpStatus.NOT_FOUND,
        ErrorCode.COMMUNITY_NOT_FOUND,
        'Community not found.',
      ),
    );
    return true;
  });

  assert.equal(getCommunityByNameMock.mock.callCount(), 1);
  assert.deepEqual(getCommunityByNameMock.mock.calls[0]!.arguments, ['missing']);
  assert.equal(joinCommunityMock.mock.callCount(), 0);
});

test('propagates lookup failures unchanged and does not attempt membership creation', async () => {
  const failure = new Error('Community lookup failed');

  getCommunityByNameMock.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(
    joinCommunityService('typescript', 17),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assert.equal(getCommunityByNameMock.mock.callCount(), 1);
  assert.deepEqual(getCommunityByNameMock.mock.calls[0]!.arguments, [
    'typescript',
  ]);
  assert.equal(joinCommunityMock.mock.callCount(), 0);
});

test('propagates membership creation failures unchanged without retrying', async () => {
  const failure = new Error('Membership creation failed');

  getCommunityByNameMock.mock.mockImplementation(async () => ({ id: 42 }));
  joinCommunityMock.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(
    joinCommunityService('typescript', 17),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assert.equal(getCommunityByNameMock.mock.callCount(), 1);
  assert.equal(joinCommunityMock.mock.callCount(), 1);
  assert.deepEqual(joinCommunityMock.mock.calls[0]!.arguments, [17, 42]);
});

test('waits for the community lookup before attempting to join', async () => {
  let resolveLookup!: (community: CommunityFixture) => void;
  const lookup = new Promise<CommunityFixture>((resolve) => {
    resolveLookup = resolve;
  });

  getCommunityByNameMock.mock.mockImplementation(() => lookup);

  const pending = joinCommunityService('typescript', 17);

  try {
    await setImmediate();

    assert.equal(getCommunityByNameMock.mock.callCount(), 1);
    assert.equal(joinCommunityMock.mock.callCount(), 0);
  } finally {
    resolveLookup({ id: 73 });
  }

  assert.deepEqual(await pending, { communityId: 73, joined: true });
  assert.equal(joinCommunityMock.mock.callCount(), 1);
  assert.deepEqual(joinCommunityMock.mock.calls[0]!.arguments, [17, 73]);
});

test('does not resolve successfully until membership creation finishes', async () => {
  let resolveJoin!: () => void;
  const membershipWrite = new Promise<void>((resolve) => {
    resolveJoin = resolve;
  });

  getCommunityByNameMock.mock.mockImplementation(async () => ({ id: 42 }));
  joinCommunityMock.mock.mockImplementation(() => membershipWrite);

  let settled = false;
  const pending = joinCommunityService('typescript', 17).then(
    (result) => {
      settled = true;
      return result;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );

  try {
    await setImmediate();

    assert.equal(joinCommunityMock.mock.callCount(), 1);
    assert.deepEqual(joinCommunityMock.mock.calls[0]!.arguments, [17, 42]);
    assert.equal(settled, false);
  } finally {
    resolveJoin();
  }

  assert.deepEqual(await pending, { communityId: 42, joined: true });
  assert.equal(settled, true);
  assert.equal(getCommunityByNameMock.mock.callCount(), 1);
});

test('passes the supplied community name to the lookup without normalization', async () => {
  const name = '  TypeScript-交流  ';

  getCommunityByNameMock.mock.mockImplementation(async () => ({ id: 81 }));

  const result = await joinCommunityService(name, 29);

  assert.equal(getCommunityByNameMock.mock.callCount(), 1);
  assert.deepEqual(getCommunityByNameMock.mock.calls[0]!.arguments, [name]);
  assert.equal(joinCommunityMock.mock.callCount(), 1);
  assert.deepEqual(joinCommunityMock.mock.calls[0]!.arguments, [29, 81]);
  assert.deepEqual(result, { communityId: 81, joined: true });
});

test('passes zero-valued identifiers through without treating them as absent', async () => {
  getCommunityByNameMock.mock.mockImplementation(async () => ({ id: 0 }));

  const result = await joinCommunityService('zero-id-community', 0);

  assert.deepEqual(result, { communityId: 0, joined: true });
  assert.equal(getCommunityByNameMock.mock.callCount(), 1);
  assert.deepEqual(getCommunityByNameMock.mock.calls[0]!.arguments, [
    'zero-id-community',
  ]);
  assert.equal(joinCommunityMock.mock.callCount(), 1);
  assert.deepEqual(joinCommunityMock.mock.calls[0]!.arguments, [0, 0]);
});
