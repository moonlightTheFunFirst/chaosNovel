export function activeNovelLimit(value = 30) {
  if (
    !/^[1-9][0-9]*$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error("MAX_ACTIVE_NOVELSは1以上の整数を設定してください。");
  return Number(value);
}
export const activeLimitMessage =
  "新しい本を公開するには、いずれかの本を完結させてください。下書きは保存されています。";
