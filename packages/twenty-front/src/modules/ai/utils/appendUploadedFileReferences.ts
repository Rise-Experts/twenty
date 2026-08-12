import { type AgentChatFileUIPart } from '@/ai/types/agent-chat-file-ui-part.type';

// Appends a durable reference to each uploaded file at the end of the message
// so the agent keeps a stable handle in context. The fileId never expires,
// unlike file.url (a short-lived signed url): the get_file_url tool resolves
// the id to a fresh signed url whenever the bytes are actually needed.
//
// The reference is encoded as a markdown link `[filename](fileid:<id>)`. The
// fileId stays in the message source the agent reads, but the renderer drops
// the unsafe `fileid:` href, so the user only ever sees the filename.
export const appendUploadedFileReferences = (
  text: string,
  uploadedFiles: AgentChatFileUIPart[],
): string => {
  if (uploadedFiles.length === 0) {
    return text;
  }

  const references = uploadedFiles
    .map((file) => `- [${file.filename}](fileid:${file.fileId})`)
    .join('\n');

  return `${text}\n\nAttached files:\n${references}`;
};
