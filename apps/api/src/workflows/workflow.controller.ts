import { ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import type { CreateWorkflowInput, UpdateWorkflowInput, WorkflowRunView, WorkflowView } from './workflow.service.js';
import { WorkflowService } from './workflow.service.js';

/**
 * Workflow API (PLAN §35, §16.1).
 *
 * `/api/v1/Workflow` and `/api/v1/WorkflowRun` are static prefixes and must be registered **before**
 * the generic record controller, otherwise `Workflow` would be read as an entity name. Everything is
 * administrator-only: a workflow is automation that runs with system authority once it is enabled.
 */
@ApiTags('workflows')
@Controller('api/v1/Workflow')
export class WorkflowController {
  constructor(@Inject(WorkflowService) private readonly workflows: WorkflowService) {}

  @Get()
  async list(): Promise<{ list: WorkflowView[]; total: number }> {
    return this.workflows.list();
  }

  @Get('action/catalog')
  async catalog(): Promise<{ events: string[]; actions: { name: string; label: string; description: string; mutatesRecords: boolean }[] }> {
    return this.workflows.catalog();
  }

  @HttpCode(200)
  @Post('action/validate')
  async validate(@Body() body: unknown): Promise<{ valid: boolean; issues: { code: string; message: string; path?: string | undefined }[] }> {
    return this.workflows.validate(definitionOf(body));
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<WorkflowView> {
    return this.workflows.get(id);
  }

  @HttpCode(201)
  @Post()
  async create(@Body() body: unknown): Promise<WorkflowView> {
    const input = asObject(body);
    return this.workflows.create({ name: String(input['name'] ?? ''), definition: input['definition'] } as CreateWorkflowInput);
  }

  @HttpCode(200)
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: unknown): Promise<WorkflowView> {
    const input = asObject(body);
    const update: UpdateWorkflowInput = {
      ...(input['name'] === undefined ? {} : { name: String(input['name']) }),
      ...(input['definition'] === undefined ? {} : { definition: input['definition'] }),
    };
    return this.workflows.update(id, update);
  }

  @HttpCode(200)
  @Post(':id/action/publish')
  async publish(@Param('id') id: string): Promise<WorkflowView> {
    return this.workflows.publish(id);
  }

  @HttpCode(200)
  @Post(':id/action/enable')
  async enable(@Param('id') id: string): Promise<WorkflowView> {
    return this.workflows.setEnabled(id, true);
  }

  @HttpCode(200)
  @Post(':id/action/disable')
  async disable(@Param('id') id: string): Promise<WorkflowView> {
    return this.workflows.setEnabled(id, false);
  }

  @HttpCode(200)
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ id: string; deleted: true }> {
    return this.workflows.remove(id);
  }

  @Get(':id/runs')
  async runs(@Param('id') id: string, @Query() query: Record<string, string | undefined>): Promise<{
    list: WorkflowRunView[];
    total: number;
    offset: number;
    count: number;
  }> {
    return this.workflows.listRuns({
      workflowId: id,
      ...statusOf(query['status']),
      ...(query['offset'] === undefined ? {} : { offset: Number(query['offset']) }),
      ...(query['limit'] === undefined ? {} : { limit: Number(query['limit']) }),
    });
  }
}

/** Run history across every workflow — the "what happened" view an operator opens first. */
@ApiTags('workflows')
@Controller('api/v1/WorkflowRun')
export class WorkflowRunController {
  constructor(@Inject(WorkflowService) private readonly workflows: WorkflowService) {}

  @Get()
  async list(@Query() query: Record<string, string | undefined>): Promise<{
    list: WorkflowRunView[];
    total: number;
    offset: number;
    count: number;
  }> {
    return this.workflows.listRuns({
      ...(query['workflowId'] === undefined ? {} : { workflowId: query['workflowId'] }),
      ...statusOf(query['status']),
      ...(query['offset'] === undefined ? {} : { offset: Number(query['offset']) }),
      ...(query['limit'] === undefined ? {} : { limit: Number(query['limit']) }),
    });
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<WorkflowRunView> {
    return this.workflows.getRun(id);
  }
}

const RUN_STATUSES = ['running', 'waiting', 'completed', 'failed', 'cancelled'] as const;

/** A status filter must be one of the known statuses; anything else is a client error. */
type RunStatusFilter = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

function statusOf(value: string | undefined): { status?: RunStatusFilter } {
  if (value === undefined || value === '') return {};
  if (!(RUN_STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(`Unknown run status "${value}".`, { allowed: RUN_STATUSES });
  }
  return { status: value as RunStatusFilter };
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function definitionOf(body: unknown): unknown {
  const input = asObject(body);
  return input['definition'] === undefined ? input : input['definition'];
}