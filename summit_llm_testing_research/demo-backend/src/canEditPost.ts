/** EXAMPLE ONLY: NOT copied from the Summit team repository. */
export function canEditPost(userId: string | null, ownerId: string): boolean {
  return userId !== null && userId === ownerId;
}
