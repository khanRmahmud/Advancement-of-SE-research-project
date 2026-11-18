import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../errors/app.error.js';
import { ErrorCode } from '../errors/error-code.js';
import { HttpStatus } from '../errors/http-status.js';

// Run with Node.js's --experimental-test-module-mocks flag.
type RepositoryUser = NonNullable<
  Awaited<ReturnType<typeof import('./auth.repositories.js').findByEmail>>
>;

const unexpectedCall = (): never => {
  throw new Error('An unrelated authentication dependency was called.');
};

const findByEmail = mock.fn(
  async (_email: string): Promise<RepositoryUser | null> => null,
);
const verify = mock.fn(
  async (_hash: string, _password: string): Promise<boolean> => true,
);
const mappedUser = {
  id: 42,
  email: 'alice@example.com',
  username: 'alice',
};
const toUserContract = mock.fn((_user: RepositoryUser) => mappedUser);
const createToken = mock.fn((_userId: number): string => 'session-token');

mock.module('./auth.repositories.js', {
  namedExports: {
    findByEmail,
    findById: unexpectedCall,
    findByUsername: unexpectedCall,
    createUnverifiedUser: unexpectedCall,
    consumePasswordResetCode: unexpectedCall,
    savePasswordResetCode: unexpectedCall,
  },
});

mock.module('./auth.mappers.js', {
  namedExports: { toUserContract },
});

mock.module('./auth.token.js', {
  namedExports: { createToken },
});

mock.module('argon2', {
  defaultExport: {
    verify,
    hash: unexpectedCall,
  },
});

mock.module('./verification/verification.code.js', {
  namedExports: { createVerificationCode: unexpectedCall },
});

mock.module('./verification/verification.console.js', {
  namedExports: { sendVerificationCode: unexpectedCall },
});

mock.module('./password-reset/password-reset.code.js', {
  namedExports: {
    createPasswordResetCode: unexpectedCall,
    hashPasswordResetCode: unexpectedCall,
  },
});

mock.module('./password-reset/password-reset.console.js', {
  namedExports: { sendPasswordResetCode: unexpectedCall },
});

const { loginService } = await import('./auth.services.js');

let user: RepositoryUser;

beforeEach(() => {
  user = {
    id: 42,
    email: 'alice@example.com',
    username: 'alice',
    passwordHash: 'stored-password-hash',
    emailVerified: true,
  } as RepositoryUser;

  findByEmail.mock.resetCalls();
  verify.mock.resetCalls();
  toUserContract.mock.resetCalls();
  createToken.mock.resetCalls();

  findByEmail.mock.mockImplementation(async () => user);
  verify.mock.mockImplementation(async () => true);
  toUserContract.mock.mockImplementation(() => mappedUser);
  createToken.mock.mockImplementation(() => 'session-token');
});

function assertLookup(email: string): void {
  assert.equal(findByEmail.mock.callCount(), 1);
  assert.deepEqual(findByEmail.mock.calls[0]!.arguments, [email]);
}

function assertPasswordVerification(password: string): void {
  assert.equal(verify.mock.callCount(), 1);
  assert.deepEqual(verify.mock.calls[0]!.arguments, [
    user.passwordHash,
    password,
  ]);
}

function assertNoSessionCreated(): void {
  assert.equal(toUserContract.mock.callCount(), 0);
  assert.equal(createToken.mock.callCount(), 0);
}

async function assertAppError(
  operation: Promise<unknown>,
  expected: AppError,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.deepEqual(error, expected);
    return true;
  });
}

test('loginService returns the mapped user and an authentication token for a verified user', async () => {
  const result = await loginService({
    email: 'alice@example.com',
    password: 'correct-password',
  });

  assert.deepEqual(result, {
    user: mappedUser,
    token: 'session-token',
  });
  assert.strictEqual(result.user, mappedUser);
  assertLookup('alice@example.com');
  assertPasswordVerification('correct-password');

  assert.equal(toUserContract.mock.callCount(), 1);
  assert.strictEqual(toUserContract.mock.calls[0]!.arguments[0], user);
  assert.equal(createToken.mock.callCount(), 1);
  assert.deepEqual(createToken.mock.calls[0]!.arguments, [user.id]);
});

test('loginService normalizes email casing and surrounding whitespace without altering the password', async () => {
  const request = {
    email: ' \tALICE@Example.COM\n',
    password: '  CaseSensitive Password\t',
  };

  const result = await loginService(request);

  assertLookup('alice@example.com');
  assertPasswordVerification('  CaseSensitive Password\t');
  assert.deepEqual(result, {
    user: mappedUser,
    token: 'session-token',
  });
  assert.equal(toUserContract.mock.callCount(), 1);
  assert.equal(createToken.mock.callCount(), 1);
  assert.equal(request.email, ' \tALICE@Example.COM\n');
  assert.equal(request.password, '  CaseSensitive Password\t');
});

test('loginService rejects a missing user, including a whitespace-only email normalized to empty', async () => {
  findByEmail.mock.mockImplementation(async () => null);

  await assertAppError(
    loginService({ email: ' \t\n ', password: 'any-password' }),
    new AppError(
      HttpStatus.NOT_FOUND,
      ErrorCode.INVALID_CREDENTIALS,
      'Invalid email.',
    ),
  );

  assertLookup('');
  assert.equal(verify.mock.callCount(), 0);
  assertNoSessionCreated();
});

test('loginService rejects an invalid password before checking whether the email is verified', async () => {
  user = { ...user, emailVerified: false };
  verify.mock.mockImplementation(async () => false);

  await assertAppError(
    loginService({
      email: 'alice@example.com',
      password: 'incorrect-password',
    }),
    new AppError(
      HttpStatus.UNAUTHORIZED,
      ErrorCode.INVALID_CREDENTIALS,
      'Invalid password.',
    ),
  );

  assertLookup('alice@example.com');
  assertPasswordVerification('incorrect-password');
  assertNoSessionCreated();
});

test('loginService denies an unverified user even when the password is valid', async () => {
  user = { ...user, emailVerified: false };

  await assertAppError(
    loginService({
      email: 'alice@example.com',
      password: 'correct-password',
    }),
    new AppError(
      HttpStatus.FORBIDDEN,
      ErrorCode.EMAIL_NOT_VERIFIED,
      'Verify your email before logging in.',
    ),
  );

  assertLookup('alice@example.com');
  assertPasswordVerification('correct-password');
  assertNoSessionCreated();
});

test('loginService propagates repository failures without verifying a password or creating a session', async () => {
  const failure = new Error('Repository lookup failed');
  findByEmail.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(
    loginService({
      email: ' ALICE@example.com ',
      password: 'correct-password',
    }),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assertLookup('alice@example.com');
  assert.equal(verify.mock.callCount(), 0);
  assertNoSessionCreated();
});

test('loginService propagates password-verifier failures without mapping a user or issuing a token', async () => {
  const failure = new Error('Password verification failed');
  verify.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(
    loginService({
      email: 'alice@example.com',
      password: 'correct-password',
    }),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assertLookup('alice@example.com');
  assertPasswordVerification('correct-password');
  assertNoSessionCreated();
});

test('loginService propagates token creation failures instead of returning a successful login', async () => {
  const failure = new Error('Token creation failed');
  createToken.mock.mockImplementation(() => {
    throw failure;
  });

  await assert.rejects(
    loginService({
      email: 'alice@example.com',
      password: 'correct-password',
    }),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assertLookup('alice@example.com');
  assertPasswordVerification('correct-password');
  assert.equal(toUserContract.mock.callCount(), 1);
  assert.strictEqual(toUserContract.mock.calls[0]!.arguments[0], user);
  assert.equal(createToken.mock.callCount(), 1);
  assert.deepEqual(createToken.mock.calls[0]!.arguments, [user.id]);
});
