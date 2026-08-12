import { FileFolder } from 'twenty-shared/types';

import { type FileUrlService } from 'src/engine/core-modules/file/file-url/file-url.service';
import { GetFileUrlTool } from 'src/engine/core-modules/tool/tools/get-file-url-tool/get-file-url-tool';
import { type ToolExecutionContext } from 'src/engine/core-modules/tool/types/tool-execution-context.type';

describe('GetFileUrlTool', () => {
  const signFileByIdUrl = jest.fn();
  const tool = new GetFileUrlTool({
    signFileByIdUrl,
  } as unknown as FileUrlService);
  const context = { workspaceId: 'ws-1' } as ToolExecutionContext;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should sign an AgentChat url scoped to the workspace for a valid fileId', async () => {
    signFileByIdUrl.mockResolvedValue('https://signed.example/file');

    const output = await tool.execute({ fileId: 'file-1' }, context);

    expect(signFileByIdUrl).toHaveBeenCalledWith({
      fileId: 'file-1',
      workspaceId: 'ws-1',
      fileFolder: FileFolder.AgentChat,
    });
    expect(output.success).toBe(true);
    expect(output.result).toEqual({
      fileId: 'file-1',
      url: 'https://signed.example/file',
    });
  });

  it('should fail without calling the signer when fileId is missing', async () => {
    const output = await tool.execute({}, context);

    expect(signFileByIdUrl).not.toHaveBeenCalled();
    expect(output.success).toBe(false);
  });

  it('should report the error when signing throws', async () => {
    signFileByIdUrl.mockRejectedValue(new Error('boom'));

    const output = await tool.execute({ fileId: 'file-1' }, context);

    expect(output.success).toBe(false);
    expect(output.error).toBe('boom');
  });
});
