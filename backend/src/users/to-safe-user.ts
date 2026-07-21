/**
 * Strip the password hash before a user row ever leaves the API.
 *
 * A plain function, not a service method: it has no dependencies, so DI would be
 * ceremony — and a method on a mocked UsersService would make "register returns no
 * password hash" a vacuous assertion. As an import it stays real in every test.
 */
export function toSafeUser<T extends { passwordHash: string }>(user: T): Omit<T, 'passwordHash'> {
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}
