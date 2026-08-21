import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { createSessionAutonameExtension } from "./extension.ts";

export default createSessionAutonameExtension({ getAgentDir });
