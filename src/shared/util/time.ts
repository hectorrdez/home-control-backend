import DateUtils from "@utils/Date";

/** MySQL DATETIME string for now. */
export function mysqlNow(): string {
  return DateUtils.toMySQLFormat(new Date());
}

/** MySQL DATETIME string for `now + hours`. Avoids `INTERVAL ?` in prepared SQL. */
export function mysqlNowPlusHours(hours: number): string {
  return DateUtils.toMySQLFormat(new Date(Date.now() + hours * 3600 * 1000));
}

/** MySQL DATETIME string for `now + days`. */
export function mysqlNowPlusDays(days: number): string {
  return DateUtils.toMySQLFormat(new Date(Date.now() + days * 86400 * 1000));
}
