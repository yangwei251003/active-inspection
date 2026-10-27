#pragma once
#include "cJSON.h"
#include "inspection_core.h"
#include <string.h>
/* The caller supplies the captured revision/time. No current global state is
 * read here: offline retries must retain the original configuration identity. */
static inline cJSON *ai_build_event_record(const char *id,const char *kind,const char *preset_id,int revision,const char *observed_at,const ai_observation_t *o,const char *evidence_url){
    cJSON *e=cJSON_CreateObject();if(!e)return NULL;
    cJSON_AddStringToObject(e,"event_id",id);cJSON_AddStringToObject(e,"kind",kind);
    if(preset_id)cJSON_AddStringToObject(e,"preset_id",preset_id);
    cJSON_AddNumberToObject(e,"preset_revision",revision);
    const char *name=o?ai_led_name(o->state):"unknown";if(!strcmp(name,"uncertain"))name="unknown";
    cJSON_AddStringToObject(e,"state",name);cJSON_AddNumberToObject(e,"confidence",o?o->confidence:0);
    if(evidence_url)cJSON_AddStringToObject(e,"evidence_url",evidence_url);else cJSON_AddNullToObject(e,"evidence_url");
    if(observed_at)cJSON_AddStringToObject(e,"at",observed_at);
    return e;
}
