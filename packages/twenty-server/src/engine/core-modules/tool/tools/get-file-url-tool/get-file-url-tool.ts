import { Injectable } from '@nestjs/common';

import { FileFolder } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { FileUrlService } from 'src/engine/core-modules/file/file-url/file-url.service';
import { GetFileUrlInputZodSchema } from 'src/engine/core-modules/tool/tools/get-file-url-tool/get-file-url-tool.schema';
import { type ToolExecutionContext } from 'src/engine/core-modules/tool/types/tool-execution-context.type';
import { type ToolInput } from 'src/engine/core-modules/tool/types/tool-input.type';
import { type ToolOutput } from 'src/engine/core-modules/tool/types/tool-output.type';
import { type Tool } from 'src/engine/core-modules/tool/types/tool.type';

@Injectable()
export class GetFileUrlTool implements Tool {
  description =
    'Resolve a file attached to the conversation into a fresh, temporary ' +
    'signed download URL. Pass the fileId from a `[filename](fileid:<id>)` ' +
    'reference in the message. The returned url can be fetched to read or ' +
    'download the file bytes. Signed urls expire, so call this again for a ' +
    'new one rather than reusing an old url.';
  inputSchema = GetFileUrlInputZodSchema;

  constructor(private readonly fileUrlService: FileUrlService) {}

  async execute(
    parameters: ToolInput,
    context: ToolExecutionContext,
  ): Promise<ToolOutput> {
    const { fileId } = parameters as { fileId?: string };

    if (!isDefined(fileId) || fileId.trim() === '') {
      return {
        success: false,
        message: 'A fileId is required to resolve a file url.',
        error: 'Missing fileId',
      };
    }

    try {
      const url = await this.fileUrlService.signFileByIdUrl({
        fileId,
        workspaceId: context.workspaceId,
        fileFolder: FileFolder.AgentChat,
      });

      return {
        success: true,
        message: `Signed url generated for file ${fileId}.`,
        result: { fileId, url },
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to generate a signed url for file ${fileId}.`,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
