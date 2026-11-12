/** ログインを許可する Google アカウント（prtimes-inbox の firestore.rules と同じ値にする） */
export const OWNER_EMAIL = 'i-kato@spark-partners.jp';

/** この画面を使ってよい人か（データの制限は firestore.rules。ここは画面の出し分けだけ） */
export function isOwner(user: { email?: string | null; emailVerified?: boolean } | null | undefined): boolean {
  return Boolean(user && user.emailVerified && user.email === OWNER_EMAIL);
}
