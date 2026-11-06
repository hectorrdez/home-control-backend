const pad = (n: number): string => String(n).padStart(2, "0");

export default class DateUtils {
  static toMySQLFormat(date: Date): string {
    return date.toISOString().slice(0, 19).replace("T", " ");
  }
  /** Local time as `YYYY/MM/DD HH:mm:ss` (envelope `entry`/`exit` format). */
  static obtainCurrentDateString(): string {
    const d = new Date();
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
}
