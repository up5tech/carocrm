import { ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';

import type { CreateEndpointInput, DeliveryView } from './endpoint.service.js';
import { asValidationError,WebhookEndpointService } from './endpoint.service.js';
import type { WebhookEndpointView } from './shared.js';
import { WebhookSecurityError } from './shared.js';

/**
 * Webhook endpoint API contributed by the `webhook-integration` package.
 *
 * The route lives under `/api/v1/WebhookEndpoint`, a static prefix the extension declares itself.
 * Every action is administrator-only (see `WebhookEndpointService`), because a registered URL is a
 * destination this installation will contact on its own initiative.
 */
@Controller('api/v1/WebhookEndpoint')
export class WebhookEndpointController {
  constructor(@Inject(WebhookEndpointService) private readonly endpoints: WebhookEndpointService) {}

  @Get()
  async list(): Promise<{ list: WebhookEndpointView[]; total: number }> {
    return this.endpoints.list();
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<WebhookEndpointView> {
    return this.endpoints.get(id);
  }

  @Get(':id/deliveries')
  async deliveries(@Param('id') id: string): Promise<{ list: DeliveryView[]; total: number }> {
    return this.endpoints.deliveries(id);
  }

  @HttpCode(201)
  @Post()
  async create(@Body() body: unknown): Promise<WebhookEndpointView> {
    return this.guard(() => this.endpoints.create(asInput(body)));
  }

  @HttpCode(200)
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: unknown): Promise<WebhookEndpointView> {
    return this.guard(() => this.endpoints.update(id, asInput(body)));
  }

  @HttpCode(200)
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ id: string; removed: true }> {
    return this.endpoints.remove(id);
  }

  /** A rejected URL is a client error (422), not a server fault. */
  private async guard<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error: unknown) {
      if (error instanceof WebhookSecurityError) throw new ValidationError(error.message);
      throw asValidationError(error);
    }
  }
}

function asInput(body: unknown): CreateEndpointInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.');
  }
  const input = body as Record<string, unknown>;
  return {
    ...(typeof input['name'] === 'string' ? { name: input['name'] } : {}),
    ...(typeof input['url'] === 'string' ? { url: input['url'] } : {}),
    ...(input['events'] === undefined ? {} : { events: input['events'] }),
    ...(typeof input['secret'] === 'string' ? { secret: input['secret'] } : {}),
    ...(typeof input['enabled'] === 'boolean' ? { enabled: input['enabled'] } : {}),
  };
}