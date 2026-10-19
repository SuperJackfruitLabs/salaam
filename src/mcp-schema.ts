import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import { ServiceError } from './protocol.js';

/** Compile only a definition whose complete catalog/tool pins have already matched. */
export function admittedMcpSchema(schema: JsonSchemaType): JsonSchemaValidator<unknown> {
  const dialect = schema.$schema;
  if (Object.hasOwn(schema, '$async') || (dialect !== undefined && typeof dialect !== 'string'))
    throw new ServiceError('mcp_schema_unsupported', 'Unsupported admitted MCP schema');
  const legacy = dialect === 'http://json-schema.org/draft-07/schema#';
  if (
    dialect !== undefined &&
    !legacy &&
    dialect !== 'https://json-schema.org/draft/2020-12/schema'
  )
    throw new ServiceError('mcp_schema_unsupported', 'Unsupported admitted MCP schema dialect');
  const options = {
    strict: false,
    strictSchema: true,
    validateSchema: true,
    validateFormats: true,
    allErrors: false,
    logger: false as const,
  };
  const ajv = legacy ? new Ajv(options) : new Ajv2020(options);
  addFormats.default(ajv);
  return new AjvJsonSchemaValidator(ajv).getValidator(schema);
}
