/** Java `long` 正数 ID 的十进制文本最大长度。 */
export const MAX_JAVA_LONG_ID_LENGTH = 19;

const POSITIVE_JAVA_LONG_SOURCE = "(?:[1-9]\\d{0,17}|[1-8]\\d{18}|9[01]\\d{17}|92[01]\\d{16}|922[0-2]\\d{15}|9223[0-2]\\d{14}|92233[0-6]\\d{13}|922337[01]\\d{12}|92233720[0-2]\\d{10}|922337203[0-5]\\d{9}|9223372036[0-7]\\d{8}|92233720368[0-4]\\d{7}|922337203685[0-3]\\d{6}|9223372036854[0-6]\\d{5}|92233720368547[0-6]\\d{4}|922337203685477[0-4]\\d{3}|9223372036854775[0-7]\\d{2}|922337203685477580[0-7])";

/** 匹配 Java `long` 正数完整范围内的十进制业务 ID。 */
export const POSITIVE_ID_PATTERN = new RegExp(`^${POSITIVE_JAVA_LONG_SOURCE}$`);

/** 匹配十进制正整数业务 ID 或钱迹的 `-1` 哨兵值。 */
export const OPTIONAL_POSITIVE_ID_PATTERN = new RegExp(`^(?:-1|${POSITIVE_JAVA_LONG_SOURCE})$`);

/** 匹配分类父 ID，并允许钱迹使用的 `-1` 和 `0` 哨兵值。 */
export const PARENT_ID_PATTERN = new RegExp(`^(?:-1|0|${POSITIVE_JAVA_LONG_SOURCE})$`);

/** 校验 APK `long` 正数 ID 的完整取值范围。 */
export function isPositiveLongId(value: string): boolean {
  return POSITIVE_ID_PATTERN.test(value);
}

/** 校验 APK 允许 `-1` 哨兵值的正数 ID。 */
export function isOptionalPositiveLongId(value: string): boolean {
  return value === "-1" || isPositiveLongId(value);
}

/** 校验 APK 分类父 ID，并允许 `-1` 和 `0` 哨兵值。 */
export function isParentLongId(value: string): boolean {
  return value === "-1" || value === "0" || isPositiveLongId(value);
}

/** APK 币种标识是非空字符串，不限定长度、大小写或字母数量。 */
export function isCurrencySymbol(value: string): boolean {
  return value.trim().length > 0;
}
