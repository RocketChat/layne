import 'dotenv/config';
declare const app: import("express-serve-static-core").Express;
declare function verifySignature(rawBody: Buffer | string | undefined, signature: string | undefined): boolean;
export declare function processWebhookRequest({ event, signature, rawBody }: {
    event: string | undefined;
    signature: string | undefined;
    rawBody: Buffer | string | undefined;
}): Promise<{
    status: number;
    body: string;
}>;
export { app, verifySignature };
//# sourceMappingURL=server.d.ts.map