import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type {
  DuitkuInquiryRequest,
  DuitkuInquiryResponse,
  DuitkuStatusRequest,
  DuitkuStatusResponse,
  DuitkuWebhookPayload,
  PaymentGateway,
} from '../domain/types.js';

const inquiryRequest: DuitkuInquiryRequest = {
  merchantOrderId: 'order-1',
  paymentAmount: 50000,
  paymentMethod: 'VC',
  productDetails: 'Lembar Pro',
  email: 'buyer@example.com',
  customerVaName: 'Buyer',
  callbackUrl: 'https://example.com/webhooks/duitku',
  returnUrl: 'https://example.com/payments/return',
};

const inquiryResponse: DuitkuInquiryResponse = {
  merchantCode: 'D1234',
  reference: 'reference-1',
  paymentUrl: 'https://example.com/pay/reference-1',
  vaNumber: '1234567890',
  amount: '50000',
  statusCode: '00',
  statusMessage: 'SUCCESS',
};

const statusRequest: DuitkuStatusRequest = { merchantOrderId: 'order-1' };
const statusResponse: DuitkuStatusResponse = {
  merchantOrderId: 'order-1',
  reference: 'reference-1',
  amount: '50000',
  fee: '0',
  statusCode: '00',
  statusMessage: 'SUCCESS',
};

const webhookPayload: DuitkuWebhookPayload = {
  merchantCode: 'D1234',
  amount: '50000',
  merchantOrderId: 'order-1',
  productDetail: 'Lembar Pro',
  additionalParam: '',
  paymentCode: 'VC',
  resultCode: '00',
  merchantUserId: 'user-1',
  reference: 'reference-1',
  signature: 'signature',
  publisherOrderId: 'publisher-order-1',
};

function getWebhookRouteSource(): string {
  const routePath = resolve(
    process.cwd(),
    'src/modules/payment/adapters/http/webhookRoutes.ts',
  );
  return readFileSync(routePath, 'utf8');
}

describe('PaymentGateway contract', () => {
  it('supports Duitku inquiry and transaction status operations', async () => {
    const gateway: PaymentGateway = {
      createTransaction: async (request: DuitkuInquiryRequest): Promise<DuitkuInquiryResponse> => {
        assert.deepEqual(request, inquiryRequest);
        return inquiryResponse;
      },
      getTransactionStatus: async (
        request: DuitkuStatusRequest,
      ): Promise<DuitkuStatusResponse> => {
        assert.deepEqual(request, statusRequest);
        return statusResponse;
      },
      verifyWebhook: (payload: DuitkuWebhookPayload): boolean =>
        payload.signature === webhookPayload.signature,
    };

    assert.deepEqual(await gateway.createTransaction(inquiryRequest), inquiryResponse);
    assert.deepEqual(await gateway.getTransactionStatus(statusRequest), statusResponse);
    assert.equal(gateway.verifyWebhook(webhookPayload), true);
  });

  it('keeps inbound webhook wiring pointed at PaymentService.handleWebhook', () => {
    const source = getWebhookRouteSource();

    assert.match(source, /paymentService\.handleWebhook\(/);
    assert.match(source, /rawBody,\s*\n\s*parsed,\s*\n\s*signature,\s*\n\s*gateway,/m);
  });
});
