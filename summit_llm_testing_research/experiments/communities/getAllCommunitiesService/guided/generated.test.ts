import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import type { DatabaseCommunity } from './communities.mappers.js';

type CommunityContract = ReturnType<
  typeof import('./communities.mappers.js')['toCommunityContract']
>;

const getAllCommunities = mock.fn(
  async (): Promise<DatabaseCommunity[]> => [],
);

const toCommunityContract = mock.fn(
  (_community: DatabaseCommunity): CommunityContract => {
    throw new Error('Unexpected mapper call');
  },
);

function unexpectedDependencyCall(): never {
  throw new Error('Unexpected dependency call');
}

mock.module('./communities.repositories.js', {
  namedExports: {
    createCommunity: unexpectedDependencyCall,
    getAllCommunities,
    getCommunityByName: unexpectedDependencyCall,
    getCommunityPosts: unexpectedDependencyCall,
    getJoinedCommunities: unexpectedDependencyCall,
    joinCommunity: unexpectedDependencyCall,
    leaveCommunity: unexpectedDependencyCall,
    updateCommunity: unexpectedDependencyCall,
  },
});

mock.module('./communities.mappers.js', {
  namedExports: { toCommunityContract },
});

mock.module('../posts/posts.mapper.js', {
  namedExports: { toPostContract: unexpectedDependencyCall },
});

const { getAllCommunitiesService } = await import('./communities.services.js');

function resetMocks(): void {
  getAllCommunities.mock.resetCalls();
  getAllCommunities.mock.mockImplementation(async () => []);
  toCommunityContract.mock.resetCalls();
  toCommunityContract.mock.mockImplementation(() => {
    throw new Error('Unexpected mapper call');
  });
}

function community(id: number, name: string): DatabaseCommunity {
  return { id, name } as DatabaseCommunity;
}

function contract(name: string): CommunityContract {
  return { name } as CommunityContract;
}

function assertRepositoryCalledOnceWithoutArguments(): void {
  assert.equal(getAllCommunities.mock.callCount(), 1);
  assert.deepEqual(getAllCommunities.mock.calls[0]!.arguments, []);
}

test('returns an empty community list without invoking the mapper', async () => {
  resetMocks();

  const result = await getAllCommunitiesService();

  assert.deepEqual(result, { communities: [] });
  assertRepositoryCalledOnceWithoutArguments();
  assert.equal(toCommunityContract.mock.callCount(), 0);
});

test('returns the mapper output rather than the database community', async () => {
  resetMocks();
  const row = community(1, 'hiking');
  const mapped = contract('public hiking community');
  getAllCommunities.mock.mockImplementation(async () => [row]);
  toCommunityContract.mock.mockImplementation((value) => {
    assert.strictEqual(value, row);
    return mapped;
  });

  const result = await getAllCommunitiesService();

  assert.deepEqual(result, { communities: [mapped] });
  assert.strictEqual(result.communities[0], mapped);
  assert.notStrictEqual(result.communities[0], row);
  assertRepositoryCalledOnceWithoutArguments();
  assert.equal(toCommunityContract.mock.callCount(), 1);
});

test('maps every community in repository order without sorting or mutating the list', async () => {
  resetMocks();
  const rows = [
    community(8, 'zoology'),
    community(2, 'astronomy'),
    community(5, 'gardening'),
  ];
  const originalRows = [...rows];
  const mapped = rows.map((row) => contract(`public ${row.name}`));
  getAllCommunities.mock.mockImplementation(async () => rows);
  toCommunityContract.mock.mockImplementation((row) => {
    const index = rows.indexOf(row);
    assert.notEqual(index, -1);
    return mapped[index]!;
  });

  const result = await getAllCommunitiesService();

  assert.deepEqual(result, { communities: mapped });
  assert.notStrictEqual(result.communities, rows);
  assert.deepEqual(rows, originalRows);
  assertRepositoryCalledOnceWithoutArguments();
  assert.equal(toCommunityContract.mock.callCount(), rows.length);
  rows.forEach((row, index) => {
    assert.strictEqual(
      toCommunityContract.mock.calls[index]!.arguments[0],
      row,
    );
    assert.strictEqual(result.communities[index], mapped[index]);
  });
});

test('preserves repeated repository entries and maps each occurrence', async () => {
  resetMocks();
  const repeated = community(3, 'photography');
  const firstMapping = contract('first occurrence');
  const secondMapping = contract('second occurrence');
  let mappingCount = 0;
  getAllCommunities.mock.mockImplementation(async () => [repeated, repeated]);
  toCommunityContract.mock.mockImplementation((row) => {
    assert.strictEqual(row, repeated);
    return mappingCount++ === 0 ? firstMapping : secondMapping;
  });

  const result = await getAllCommunitiesService();

  assert.deepEqual(result, {
    communities: [firstMapping, secondMapping],
  });
  assertRepositoryCalledOnceWithoutArguments();
  assert.equal(toCommunityContract.mock.callCount(), 2);
});

test('propagates a repository rejection unchanged without mapping', async () => {
  resetMocks();
  const failure = new Error('Repository unavailable');
  getAllCommunities.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(getAllCommunitiesService(), (error: unknown) => {
    assert.strictEqual(error, failure);
    return true;
  });

  assertRepositoryCalledOnceWithoutArguments();
  assert.equal(toCommunityContract.mock.callCount(), 0);
});

test('rejects with the original mapper error when the first community cannot be mapped', async () => {
  resetMocks();
  const row = community(4, 'cycling');
  const failure = new Error('Community mapping failed');
  getAllCommunities.mock.mockImplementation(async () => [row]);
  toCommunityContract.mock.mockImplementation(() => {
    throw failure;
  });

  await assert.rejects(getAllCommunitiesService(), (error: unknown) => {
    assert.strictEqual(error, failure);
    return true;
  });

  assertRepositoryCalledOnceWithoutArguments();
  assert.equal(toCommunityContract.mock.callCount(), 1);
  assert.strictEqual(toCommunityContract.mock.calls[0]!.arguments[0], row);
});

test('stops mapping after a later mapper failure instead of returning partial results', async () => {
  resetMocks();
  const rows = [
    community(1, 'running'),
    community(2, 'climbing'),
    community(3, 'swimming'),
  ];
  const failure = new Error('Second community cannot be mapped');
  getAllCommunities.mock.mockImplementation(async () => rows);
  toCommunityContract.mock.mockImplementation((row) => {
    if (row === rows[1]) {
      throw failure;
    }
    assert.strictEqual(row, rows[0]);
    return contract('running');
  });

  await assert.rejects(getAllCommunitiesService(), (error: unknown) => {
    assert.strictEqual(error, failure);
    return true;
  });

  assertRepositoryCalledOnceWithoutArguments();
  assert.equal(toCommunityContract.mock.callCount(), 2);
  assert.strictEqual(toCommunityContract.mock.calls[0]!.arguments[0], rows[0]);
  assert.strictEqual(toCommunityContract.mock.calls[1]!.arguments[0], rows[1]);
});

test('waits for the repository promise before mapping and returning communities', async () => {
  resetMocks();
  const row = community(9, 'birdwatching');
  const mapped = contract('birdwatching');
  let resolveRepository!: (rows: DatabaseCommunity[]) => void;
  const repositoryResult = new Promise<DatabaseCommunity[]>((resolve) => {
    resolveRepository = resolve;
  });
  getAllCommunities.mock.mockImplementation(() => repositoryResult);
  toCommunityContract.mock.mockImplementation((value) => {
    assert.strictEqual(value, row);
    return mapped;
  });

  let settled = false;
  const pendingResult = getAllCommunitiesService().then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();

  assertRepositoryCalledOnceWithoutArguments();
  assert.equal(settled, false);
  assert.equal(toCommunityContract.mock.callCount(), 0);

  resolveRepository([row]);
  const result = await pendingResult;

  assert.equal(settled, true);
  assert.deepEqual(result, { communities: [mapped] });
  assert.strictEqual(result.communities[0], mapped);
  assert.equal(toCommunityContract.mock.callCount(), 1);
});
