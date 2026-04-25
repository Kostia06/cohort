export { UserAgentDO } from '../do/user-agent-do';

export default {
  async fetch(): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
};
