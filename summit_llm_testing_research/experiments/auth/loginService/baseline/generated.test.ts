import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../errors/app.error.js';
import { ErrorCode } from '../errors/error-code.js';
import { HttpStatus } from '../errors/http-status.js';

const user = {
  id: 42,
  email: 'alice@example.com',
  username: 'alice',
  passwordHash: 'stored-password-hash',
  emailVerified: true,
};

type TestUser = typeof user;

const userContract = {
  id: user.id,
  email: user.email,
  username: user.username,
};

const findByEmail = mock.fn(
  async (_email: string): Promise<TestUser | null> => user,
);
const verify = mock.fn(
  async (_hash: string, _password: string): Promise<boolean> => true,
);
const toUserContract = mock.fn((_user: TestUser) => userContract);
const createToken = mock.fn((_userId: number): string => 'signed-token');

function unexpectedDependency(): never {
  throw new Error('loginService called an unrelated dependency');
}

mock.module('./auth.repositories.js', {
  namedExports: {
    findByEmail,
    findById: unexpectedDependency,
    findByUsername: unexpectedDependency,
    createUnverifiedUser: unexpectedDependency,
    savePasswordResetCode: unexpectedDependency,
    consumePasswordResetCode: unexpectedDependency,
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
    hash: unexpectedDependency,
  },
});

mock.module('./verification/verification.code.js', {
  namedExports: { createVerificationCode: unexpectedDependency },
});

mock.module('./verification/verification.console.js', {
  namedExports: { sendVerificationCode: unexpectedDependency },
});

mock.module('./password-reset/password-reset.code.js', {
  namedExports: {
    createPasswordResetCode: unexpectedDependency,
    hashPasswordResetCode: unexpectedDependency,
  },
});

mock.module('./password-reset/password-reset.console.js', {
  namedExports: { sendPasswordResetCode: unexpectedDependency },
});

const { loginService } = await import('./auth.services.js');

function resetDependencies(): void {
  findByEmail.mock.resetCalls();
  verify.mock.resetCalls();
  toUserContract.mock.resetCalls();
  createToken.mock.resetCalls();

  findByEmail.mock.mockImplementation(async () => user);
  verify.mock.mockImplementation(async () => true);
  toUserContract.mock.mockImplementation(() => userContract);
  createToken.mock.mockImplementation(() => 'signed-token');
}

function assertNoResponseConstruction(): void {
  assert.equal(toUserContract.mock.callCount(), 0);
  assert.equal(createToken.mock.callCount(), 0);
}

test('loginService normalizes email, preserves password whitespace, and returns the mapped user and token', { concurrency: false }, async () => {
  resetDependencies();

  const result = await loginService({
    email: ' \tALICE@EXAMPLE.COM\n',
    password: '  exact password  ',
  });

  assert.deepEqual(result, {
    user: userContract,
    token: 'signed-token',
  });
  assert.strictEqual(result.user, userContract);
  assert.equal(findByEmail.mock.callCount(), 1);
  assert.deepEqual(findByEmail.mock.calls[0]!.arguments, [
    'alice@example.com',
  ]);
  assert.equal(verify.mock.callCount(), 1);
  assert.deepEqual(verify.mock.calls[0]!.arguments, [
    user.passwordHash,
    '  exact password  ',
  ]);
  assert.equal(toUserContract.mock.callCount(), 1);
  assert.strictEqual(toUserContract.mock.calls[0]!.arguments[0], user);
  assert.equal(createToken.mock.callCount(), 1);
  assert.deepEqual(createToken.mock.calls[0]!.arguments, [user.id]);
});

test('loginService rejects an unknown email without verifying a password or creating a response', { concurrency: false }, async () => {
  resetDependencies();
  findByEmail.mock.mockImplementation(async () => null);

  await assert.rejects(
    loginService({
      email: 'missing@example.com',
      password: 'password',
    }),
    new AppError(
      HttpStatus.NOT_FOUND,
      ErrorCode.INVALID_CREDENTIALS,
      'Invalid email.',
    ),
  );

  assert.equal(findByEmail.mock.callCount(), 1);
  assert.deepEqual(findByEmail.mock.calls[0]!.arguments, [
    'missing@example.com',
  ]);
  assert.equal(verify.mock.callCount(), 0);
  assertNoResponseConstruction();
});

test('loginService verifies an empty password and rejects it before checking email verification', { concurrency: false }, async () => {
  resetDependencies();
  const unverifiedUser = { ...user, emailVerified: false };
  findByEmail.mock.mockImplementation(async () => unverifiedUser);
  verify.mock.mockImplementation(async () => false);

  await assert.rejects(
    loginService({ email: user.email, password: '' }),
    new AppError(
      HttpStatus.UNAUTHORIZED,
      ErrorCode.INVALID_CREDENTIALS,
      'Invalid password.',
    ),
  );

  assert.equal(findByEmail.mock.callCount(), 1);
  assert.equal(verify.mock.callCount(), 1);
  assert.deepEqual(verify.mock.calls[0]!.arguments, [
    unverifiedUser.passwordHash,
    '',
  ]);
  assertNoResponseConstruction();
});

test('loginService rejects an unverified email after successful password verification', { concurrency: false }, async () => {
  resetDependencies();
  const unverifiedUser = { ...user, emailVerified: false };
  findByEmail.mock.mockImplementation(async () => unverifiedUser);

  await assert.rejects(
    loginService({ email: user.email, password: 'correct-password' }),
    new AppError(
      HttpStatus.FORBIDDEN,
      ErrorCode.EMAIL_NOT_VERIFIED,
      'Verify your email before logging in.',
    ),
  );

  assert.equal(findByEmail.mock.callCount(), 1);
  assert.equal(verify.mock.callCount(), 1);
  assert.deepEqual(verify.mock.calls[0]!.arguments, [
    unverifiedUser.passwordHash,
    'correct-password',
  ]);
  assertNoResponseConstruction();
});

test('loginService propagates a repository rejection without invoking downstream dependencies', { concurrency: false }, async () => {
  resetDependencies();
  const failure = new Error('Repository unavailable');
  findByEmail.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(
    loginService({
      email: ' ALICE@EXAMPLE.COM ',
      password: 'password',
    }),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assert.equal(findByEmail.mock.callCount(), 1);
  assert.deepEqual(findByEmail.mock.calls[0]!.arguments, [user.email]);
  assert.equal(verify.mock.callCount(), 0);
  assertNoResponseConstruction();
});

test('loginService propagates a password verifier rejection without mapping the user or creating a token', { concurrency: false }, async () => {
  resetDependencies();
  const failure = new Error('Password hash verification failed');
  verify.mock.mockImplementation(async () => {
    throw failure;
  });

  await assert.rejects(
    loginService({ email: user.email, password: 'password' }),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assert.equal(findByEmail.mock.callCount(), 1);
  assert.equal(verify.mock.callCount(), 1);
  assert.deepEqual(verify.mock.calls[0]!.arguments, [
    user.passwordHash,
    'password',
  ]);
  assertNoResponseConstruction();
});

test('loginService propagates a mapper error and does not create a token', { concurrency: false }, async () => {
  resetDependencies();
  const failure = new Error('User mapping failed');
  toUserContract.mock.mockImplementation(() => {
    throw failure;
  });

  await assert.rejects(
    loginService({ email: user.email, password: 'password' }),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assert.equal(findByEmail.mock.callCount(), 1);
  assert.equal(verify.mock.callCount(), 1);
  assert.equal(toUserContract.mock.callCount(), 1);
  assert.strictEqual(toUserContract.mock.calls[0]!.arguments[0], user);
  assert.equal(createToken.mock.callCount(), 0);
});

test('loginService propagates a token creation error after mapping the authenticated user', { concurrency: false }, async () => {
  resetDependencies();
  const failure = new Error('Token signing failed');
  createToken.mock.mockImplementation(() => {
    throw failure;
  });

  await assert.rejects(
    loginService({ email: user.email, password: 'password' }),
    (error: unknown) => {
      assert.strictEqual(error, failure);
      return true;
    },
  );

  assert.equal(findByEmail.mock.callCount(), 1);
  assert.equal(verify.mock.callCount(), 1);
  assert.equal(toUserContract.mock.callCount(), 1);
  assert.strictEqual(toUserContract.mock.calls[0]!.arguments[0], user);
  assert.equal(createToken.mock.callCount(), 1);
  assert.deepEqual(createToken.mock.calls[0]!.arguments, [user.id]);
});
