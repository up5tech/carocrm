import { ValidationError } from '@carocrm/core/errors/index.js';
import type { FieldDefinition } from '@carocrm/metadata/schemas/index.js';

export interface ValidationResult {
  valid: boolean;
  errors?: Record<string, string> | undefined;
}

export class FieldValidator {
  private fieldDef: FieldDefinition;

  constructor(fieldDef: FieldDefinition) {
    this.fieldDef = fieldDef;
  }

  validate(value: unknown): ValidationResult {
    const errors: Record<string, string> = {};

    if (value === undefined || value === null) {
      if (this.fieldDef.required) {
        errors.value = 'Field is required.';
      }
      return { valid: Object.keys(errors).length === 0, errors: Object.keys(errors).length ? errors : undefined };
    }

    switch (this.fieldDef.type) {
      case 'varchar':
      case 'text':
      case 'enum':
      case 'currency':
      case 'url':
      case 'email':
      case 'phone':
        if (typeof value !== 'string') {
          errors.value = 'Value must be a string.';
        } else {
          if (this.fieldDef.maxLength && value.length > this.fieldDef.maxLength) {
            errors.value = `Value must not exceed ${this.fieldDef.maxLength} characters.`;
          }
          if (this.fieldDef.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            errors.value = 'Value must be a valid email address.';
          }
          if (this.fieldDef.type === 'url' && !/^https?:\/\/.+/.test(value)) {
            errors.value = 'Value must be a valid URL.';
          }
          if (this.fieldDef.type === 'enum' && this.fieldDef.enum && !this.fieldDef.enum.includes(value)) {
            errors.value = `Value must be one of: ${this.fieldDef.enum.join(', ')}.`;
          }
        }
        break;

      case 'int':
      case 'float':
      case 'decimal':
        if (typeof value !== 'number' || Number.isNaN(value)) {
          errors.value = 'Value must be a number.';
        }
        break;

      case 'bool':
        if (typeof value !== 'boolean') {
          errors.value = 'Value must be a boolean.';
        }
        break;

      case 'date':
      case 'datetime':
        if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
          errors.value = 'Value must be a valid date.';
        }
        break;

      case 'multiEnum':
        if (!Array.isArray(value)) {
          errors.value = 'Value must be an array.';
        } else if (this.fieldDef.enum) {
          for (const item of value) {
            if (!this.fieldDef.enum.includes(item)) {
              errors.value = `Invalid enum value: ${item}.`;
              break;
            }
          }
        }
        break;

      case 'link':
      case 'linkOne':
      case 'foreign':
        if (typeof value !== 'string') {
          errors.value = 'Value must be a string ID.';
        }
        break;

      case 'linkMultiple':
      case 'attachmentMultiple':
        if (!Array.isArray(value)) {
          errors.value = 'Value must be an array.';
        } else {
          for (const item of value) {
            if (typeof item !== 'string') {
              errors.value = 'All items must be string IDs.';
              break;
            }
          }
        }
        break;

      case 'file':
      case 'image':
        if (typeof value !== 'object' || value === null) {
          errors.value = 'Value must be a file object.';
        }
        break;

      case 'password':
        if (typeof value !== 'string' || value.length < 8) {
          errors.value = 'Password must be at least 8 characters.';
        }
        break;
    }

    return { valid: Object.keys(errors).length === 0, errors: Object.keys(errors).length ? errors : undefined };
  }
}

export class RecordValidator {
  private validators = new Map<string, FieldValidator>();

  constructor(fields: Record<string, FieldDefinition>) {
    for (const [name, def] of Object.entries(fields)) {
      this.validators.set(name, new FieldValidator(def));
    }
  }

  validate(data: Record<string, unknown>): ValidationResult {
    const allErrors: Record<string, string> = {};

    for (const [field, validator] of this.validators) {
      const result = validator.validate(data[field]);
      if (result.errors) {
        allErrors[field] = Object.values(result.errors)[0] ?? 'Invalid value.';
      }
    }

    return {
      valid: Object.keys(allErrors).length === 0,
      errors: Object.keys(allErrors).length ? allErrors : undefined,
    };
  }

  validateField(field: string, value: unknown): ValidationResult {
    const validator = this.validators.get(field);
    if (!validator) {
      return { valid: true };
    }
    return validator.validate(value);
  }
}

export function validateRecord(data: Record<string, unknown>, fields: Record<string, FieldDefinition>): void {
  const validator = new RecordValidator(fields);
  const result = validator.validate(data);
  if (!result.errors) return;
  throw new ValidationError('Record validation failed.', result.errors);
}