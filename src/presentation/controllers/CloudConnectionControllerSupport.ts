import type { Request, Response } from "express";
import type { IngestionSourceType } from "../../domain/models/CloudConnection.js";
import { FinOpsBaseError } from "../../domain/errors/errors.js";
import { respondWithFinOpsError } from "../http/finOpsErrorResponse.js";
import { CloudConnectionRequestParser } from "./cloudConnectionRequestParser.js";

/** Shared parsing, authentication and HTTP error translation for cloud handlers. */
export abstract class CloudConnectionControllerSupport {
  protected readonly requestParser = new CloudConnectionRequestParser();

  protected requireAuth(req: Request) {
    if (req.auth === undefined) {
      throw new FinOpsBaseError(
        "Debes iniciar sesión para continuar.",
        "AUTHENTICATION_REQUIRED",
      );
    }

    return req.auth;
  }

  protected requireTenant(req: Request): string {
    return this.requestParser.requireTenant(req);
  }
  protected requireParam(req: Request, name: string): string {
    return this.requestParser.requireParam(req, name);
  }
  protected requireObjectBody(body: unknown): Record<string, unknown> {
    return this.requestParser.requireObjectBody(body);
  }
  protected requireString(value: unknown, fieldName: string): string {
    return this.requestParser.requireString(value, fieldName);
  }
  protected parseDate(value: unknown, fieldName: string): Date {
    return this.requestParser.parseDate(value, fieldName);
  }
  protected parseSourceType(value: unknown): IngestionSourceType {
    return this.requestParser.parseSourceType(value);
  }
  protected parseCredentialPurpose(value: unknown) {
    return this.requestParser.parseCredentialPurpose(value);
  }
  protected parseFocusSourceMode(value: unknown) {
    return this.requestParser.parseFocusSourceMode(value);
  }
  protected parseBillingSourceMode(value: unknown) {
    return this.requestParser.parseBillingSourceMode(value);
  }
  protected requireStringRecord(
    value: unknown,
    fieldName: string,
  ): Readonly<Record<string, string>> {
    return this.requestParser.requireStringRecord(value, fieldName);
  }
  protected parseLimit(value: unknown): number | undefined {
    return this.requestParser.parseLimit(value);
  }
  protected parseOptionalNumber(
    value: unknown,
    fieldName: string,
  ): number | undefined {
    return this.requestParser.parseOptionalNumber(value, fieldName);
  }
  protected isRecord(value: unknown): value is Record<string, unknown> {
    return this.requestParser.isRecord(value);
  }

  protected respondWithError(res: Response, error: unknown): void {
    respondWithFinOpsError(
      res,
      error,
      "An unexpected error occurred processing cloud connections",
      "cloud_connection_operation_failed",
    );
  }
}
