export class UserAgentDO {
  state: DurableObjectState;
  env: unknown;

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    this.env = env;
  }

  async fetch(): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
}
