export function isAllowedTelegramUser(
  userId: number | undefined,
  allowedUserIds: readonly number[],
) {
  return typeof userId === "number" && allowedUserIds.includes(userId);
}
