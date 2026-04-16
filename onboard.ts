import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";





export const AXONHUB_DEFAULT_MODEL_REF = "axonhub/gpt-5.4";


const AXONHUB_PROVIDER_ID = "axonhub";





export function applyAxonhubConfig(config: OpenClawConfig): void {


  if (!config.models) {


    config.models = {};


  }


  if (!config.models.providers) {


    config.models.providers = {};


  }


  if (!config.models.providers[AXONHUB_PROVIDER_ID]) {


    config.models.providers[AXONHUB_PROVIDER_ID] = {};


  }





  const providerConfig = config.models.providers[AXONHUB_PROVIDER_ID];





  if (!providerConfig.defaultModel) {


    providerConfig.defaultModel = AXONHUB_DEFAULT_MODEL_REF;


  }





  if (providerConfig.defaultModel && !providerConfig.defaultModel.startsWith(AXONHUB_PROVIDER_ID)) {


    providerConfig.defaultModel = `${AXONHUB_PROVIDER_ID}/${providerConfig.defaultModel}`;


  }


}