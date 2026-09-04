interface DecimalParts {
  coefficient: bigint;
  scale: number;
}

/** 按 `BigDecimal.valueOf(double)` 的十进制文本语义相加。 */
export function decimalAdd(left: number, right: number): number {
  const [a, b] = align(decimalParts(left), decimalParts(right));
  return decimalNumber({ coefficient: a.coefficient + b.coefficient, scale: a.scale });
}

/** 按 `BigDecimal.valueOf(double)` 的十进制文本语义相减。 */
export function decimalSubtract(left: number, right: number): number {
  return decimalAdd(left, -right);
}

/** 按 `BigDecimal.valueOf(double)` 的十进制文本语义相乘。 */
export function decimalMultiply(left: number, right: number): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  return decimalNumber({ coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale });
}

/** 按指定小数位和舍入模式执行十进制除法。 */
export function decimalDivide(
  left: number,
  right: number,
  scale: number,
): number {
  if (!Number.isInteger(scale) || scale < 0) throw new RangeError("十进制除法的小数位必须是非负整数");
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (b.coefficient === 0n) throw new RangeError("十进制除数不能为零");
  const negative = (a.coefficient < 0n) !== (b.coefficient < 0n);
  let numerator = abs(a.coefficient);
  let denominator = abs(b.coefficient);
  const shift = scale + b.scale - a.scale;
  if (shift >= 0) numerator *= power10(shift);
  else denominator *= power10(-shift);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const comparison = remainder * 2n - denominator;
  if (comparison >= 0n) quotient++;
  return decimalNumber({ coefficient: negative ? -quotient : quotient, scale });
}

/** 按指定小数位和舍入模式执行十进制舍入。 */
export function decimalRound(value: number, scale: number): number {
  return decimalDivide(value, 1, scale);
}

/** 按 Java `NumberFormat` 对 IEEE-754 double 的实际值执行舍入。 */
export function binaryRound(value: number, scale: number): number {
  if (!Number.isFinite(value)) throw new RangeError("二进制舍入只接受有限数字");
  if (!Number.isInteger(scale) || scale < 0) throw new RangeError("二进制舍入的小数位必须是非负整数");
  if (value === 0) return 0;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const negative = (bits >> 63n) !== 0n;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0x000f_ffff_ffff_ffffn;
  let numerator = exponentBits === 0 ? fraction : (1n << 52n) | fraction;
  const binaryExponent = (exponentBits === 0 ? -1022 : exponentBits - 1023) - 52;
  let denominator = 1n;
  if (binaryExponent >= 0) numerator <<= BigInt(binaryExponent);
  else denominator <<= BigInt(-binaryExponent);
  numerator *= power10(scale);
  let quotient = numerator / denominator;
  const comparison = numerator % denominator * 2n - denominator;
  if (comparison > 0n || (comparison === 0n && quotient % 2n !== 0n)) quotient++;
  return decimalNumber({ coefficient: negative ? -quotient : quotient, scale });
}

function decimalParts(value: number): DecimalParts {
  if (!Number.isFinite(value)) throw new RangeError("十进制运算只接受有限数字");
  const text = value.toString().toLowerCase();
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [mantissa, exponentText] = unsigned.split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [integer, fraction = ""] = mantissa!.split(".");
  let coefficient = BigInt(`${integer}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= power10(-scale);
    scale = 0;
  }
  if (negative) coefficient = -coefficient;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale--;
  }
  return { coefficient, scale };
}

function align(left: DecimalParts, right: DecimalParts): [DecimalParts, DecimalParts] {
  const scale = Math.max(left.scale, right.scale);
  return [
    { coefficient: left.coefficient * power10(scale - left.scale), scale },
    { coefficient: right.coefficient * power10(scale - right.scale), scale },
  ];
}

function decimalNumber(value: DecimalParts): number {
  const negative = value.coefficient < 0n;
  const digits = abs(value.coefficient).toString().padStart(value.scale + 1, "0");
  const unsigned = value.scale === 0
    ? digits
    : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
  const result = Number(`${negative ? "-" : ""}${unsigned}`);
  if (!Number.isFinite(result)) throw new RangeError("十进制运算结果超出有限数字范围");
  return result;
}

function power10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
