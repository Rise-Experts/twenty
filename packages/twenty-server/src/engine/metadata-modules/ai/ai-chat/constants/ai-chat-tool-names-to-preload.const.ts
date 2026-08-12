import { COMMON_PRELOAD_TOOLS } from 'src/engine/core-modules/tool-provider/constants/common-preload-tools.const';

export const AI_CHAT_TOOL_NAMES_TO_PRELOAD: string[] = [
  ...COMMON_PRELOAD_TOOLS,
  'app_exa_web_search',
  // Files attached to a chat message are referenced by fileId; preload the
  // resolver so the agent can turn that id into a signed url without having to
  // discover the tool first.
  'get_file_url',
];
