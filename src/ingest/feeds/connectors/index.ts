import type { FeedConnector } from '../types.js';
import { arxivConnector } from './arxiv.js';
import { commandConnector, pushConnector } from './command.js';
import { emailConnector } from './email.js';
import { feishuChatConnector } from './feishu-chat.js';
import { githubConnector } from './github.js';
import { opencliConnector } from './opencli.js';
import { rssConnector } from './rss.js';
import { webConnector } from './web.js';
import { xConnector } from './x.js';

/** The connectors knode-os ships with, registered through the plugin API (src/plugins/builtin.ts). */
export function builtinFeedConnectors(): FeedConnector[] {
  return [feishuChatConnector, emailConnector, rssConnector, arxivConnector, githubConnector, xConnector, opencliConnector, webConnector, pushConnector, commandConnector];
}
