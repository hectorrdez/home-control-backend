export default class ApiError extends Error {
  constructor(
    private msg: string = "",
    private code: number = 500,
    private errorCode: string = ""
  ) {
    super(`ERROR ${code}: ${msg}`);
  }

  public getMessage(): string {
    return this.msg;
  }
  public getCode(): number {
    return this.code;
  }
  /**
   * Stable machine-readable code for the envelope's `error` field. Falls back
   * to a snake_case slug of the concrete class name, then to a generic code.
   * Never a stack trace.
   */
  public getErrorCode(): string {
    if (this.errorCode) return this.errorCode;
    const fromClass = ApiError.slug(this.constructor.name);
    return fromClass || (this.code === 404 ? "not_found" : "internal_error");
  }

  private static slug(name: string): string {
    if (!name || name === "ApiError" || name === "Error") return "";
    return name
      .replace(/Error$/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();
  }
}
