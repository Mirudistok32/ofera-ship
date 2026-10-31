/* Ошибка с HTTP-статусом: всё, что бросают роуты, превращается в { error: { code, message, fields, requestId } } */
export class HttpError extends Error {
  constructor(status, code, message, { fields, headers, extra } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.headers = headers;
    this.extra = extra;
  }
}
