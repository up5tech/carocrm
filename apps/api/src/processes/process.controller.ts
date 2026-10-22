import { ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import type { CreateProcessInput, ProcessView, UpdateProcessInput } from './process.service.js';
import { ProcessService } from './process.service.js';
import type { ProcessInstanceView, ProcessTaskView, StartProcessInput } from './process-runtime.service.js';
import { ProcessRuntimeService } from './process-runtime.service.js';

/**
 * Process definition API (PLAN §36, §16.1).
 *
 * `/api/v1/Process` is a static prefix registered **before** the generic record controller, so
 * "Process" is never read as an entity name. Definitions are administrator-only: a process runs
 * actions with system authority once it is enabled.
 */
@ApiTags('processes')
@Controller('api/v1/Process')
export class ProcessController {
  constructor(@Inject(ProcessService) private readonly processes: ProcessService) {}

  @Get()
  async list(): Promise<{ list: ProcessView[]; total: number }> {
    return this.processes.list();
  }

  /** The editor's vocabulary: action catalog, node types and assignee kinds. */
  @Get('action/catalog')
  async catalog(): Promise<Awaited<ReturnType<ProcessService['catalog']>>> {
    return this.processes.catalog();
  }

  /**
   * What a participant may start on a record type. Declared before `:id` so "action" is never read
   * as a process id. Not admin-only: this is the start menu, and it exposes identity only.
   */
  @Get('action/available')
  async available(@Query('entityType') entityType: string | undefined): Promise<Awaited<ReturnType<ProcessService['available']>>> {
    return this.processes.available(entityType ?? '');
  }

  @HttpCode(200)
  @Post('action/validate')
  async validate(@Body() body: unknown): Promise<{ valid: boolean; issues: { code: string; message: string; path?: string | undefined }[] }> {
    return this.processes.validate(definitionOf(body));
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<ProcessView> {
    return this.processes.get(id);
  }

  @HttpCode(201)
  @Post()
  async create(@Body() body: unknown): Promise<ProcessView> {
    const input = asObject(body);
    return this.processes.create({
      key: String(input['key'] ?? ''),
      name: String(input['name'] ?? ''),
      ...(input['description'] === undefined ? {} : { description: String(input['description']) }),
      definition: input['definition'],
    } as CreateProcessInput);
  }

  @HttpCode(200)
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: unknown): Promise<ProcessView> {
    const input = asObject(body);
    const update: UpdateProcessInput = {
      ...(input['name'] === undefined ? {} : { name: String(input['name']) }),
      ...(input['description'] === undefined ? {} : { description: String(input['description']) }),
      ...(input['definition'] === undefined ? {} : { definition: input['definition'] }),
    };
    return this.processes.update(id, update);
  }

  @HttpCode(200)
  @Post(':id/action/publish')
  async publish(@Param('id') id: string): Promise<ProcessView> {
    return this.processes.publish(id);
  }

  @HttpCode(200)
  @Post(':id/action/enable')
  async enable(@Param('id') id: string): Promise<ProcessView> {
    return this.processes.setEnabled(id, true);
  }

  @HttpCode(200)
  @Post(':id/action/disable')
  async disable(@Param('id') id: string): Promise<ProcessView> {
    return this.processes.setEnabled(id, false);
  }

  @HttpCode(200)
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ id: string; deleted: true }> {
    return this.processes.remove(id);
  }
}

/**
 * Process instance API (PLAN §36).
 *
 * Not admin-only on purpose: starting an approval is done by whoever owns the record (read access
 * is enforced server-side), and answering a task is done by the assignee or a candidate of the
 * task's role. Everything else — reading definitions, administering them — stays behind admin.
 */
@ApiTags('processes')
@Controller('api/v1/ProcessInstance')
export class ProcessInstanceController {
  constructor(@Inject(ProcessRuntimeService) private readonly runtime: ProcessRuntimeService) {}

  @Get()
  async list(@Query() query: Record<string, string | undefined>): Promise<{
    list: ProcessInstanceView[];
    total: number;
    offset: number;
    count: number;
  }> {
    return this.runtime.listInstances({
      ...(query['definitionId'] === undefined ? {} : { definitionId: query['definitionId'] }),
      ...(query['status'] === undefined ? {} : { status: query['status'] }),
      // Record-scoped lists power the process panel on a record; the participant scope still applies.
      ...(query['entityType'] === undefined ? {} : { entityType: query['entityType'] }),
      ...(query['entityId'] === undefined ? {} : { entityId: query['entityId'] }),
      ...(query['offset'] === undefined ? {} : { offset: Number(query['offset']) }),
      ...(query['limit'] === undefined ? {} : { limit: Number(query['limit']) }),
    });
  }

  @HttpCode(201)
  @Post()
  async start(@Body() body: unknown): Promise<ProcessInstanceView> {
    const input = asObject(body);
    const start: StartProcessInput = {
      ...(input['processId'] === undefined ? {} : { processId: String(input['processId']) }),
      ...(input['processKey'] === undefined ? {} : { processKey: String(input['processKey']) }),
      entityType: String(input['entityType'] ?? ''),
      entityId: String(input['entityId'] ?? ''),
    };
    if (start.processId === undefined && start.processKey === undefined) {
      throw new ValidationError('Name the process to start by "processId" or "processKey".');
    }
    return this.runtime.start(start);
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<ProcessInstanceView> {
    return this.runtime.getInstance(id);
  }

  @HttpCode(200)
  @Post(':id/action/cancel')
  async cancel(@Param('id') id: string): Promise<ProcessInstanceView> {
    return this.runtime.cancel(id);
  }
}

/**
 * Task API (PLAN §36 "User task").
 *
 * This is the surface a *participant* uses — a manager approving an opportunity never needs admin
 * rights, and never sees processes they are not part of. `all=true` is admin-only.
 */
@ApiTags('processes')
@Controller('api/v1/ProcessTask')
export class ProcessTaskController {
  constructor(@Inject(ProcessRuntimeService) private readonly runtime: ProcessRuntimeService) {}

  @Get()
  async list(@Query() query: Record<string, string | undefined>): Promise<{
    list: ProcessTaskView[];
    total: number;
    offset: number;
    count: number;
  }> {
    return this.runtime.listTasks({
      ...(query['status'] === undefined ? {} : { status: query['status'] }),
      ...(query['all'] === undefined ? {} : { all: query['all'] === 'true' }),
      ...(query['offset'] === undefined ? {} : { offset: Number(query['offset']) }),
      ...(query['limit'] === undefined ? {} : { limit: Number(query['limit']) }),
    });
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<ProcessTaskView> {
    return this.runtime.getTask(id);
  }

  @HttpCode(200)
  @Post(':id/action/complete')
  async complete(@Param('id') id: string, @Body() body: unknown): Promise<ProcessInstanceView> {
    const input = asObject(body);
    return this.runtime.completeTask(id, {
      outcome: String(input['outcome'] ?? ''),
      ...(input['comment'] === undefined ? {} : { comment: String(input['comment']) }),
    });
  }
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
