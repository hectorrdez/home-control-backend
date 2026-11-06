import connection from "../utils/Connection";
import MethodNotImplementedError from "../errors/MethodNotImplementedError";

export default abstract class Model {
  protected static connection = connection;

  public static async find(_element: unknown): Promise<unknown> {
    throw new MethodNotImplementedError();
  }
  public static async findById(_id: string): Promise<unknown> {
    throw new MethodNotImplementedError();
  }
}
