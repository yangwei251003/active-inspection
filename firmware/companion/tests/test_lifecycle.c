#include "inspection_core.h"
#include "../main/event_record.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
int main(void){
    ai_capture_request_t r={0};int64_t now=1800000000000LL;
    assert(ai_capture_begin(&r,"old","one",7,now+5000,now));
    assert(ai_capture_valid(&r,"one",7,now+4999));
    assert(!ai_capture_valid(&r,"two",7,now));
    assert(!ai_capture_valid(&r,"one",8,now));
    assert(!ai_capture_valid(&r,"one",7,now+5000));
    assert(!ai_capture_complete(&r,"old","two",7,now));
    ai_capture_cancel(&r);assert(!r.pending&&!r.id[0]);
    assert(ai_capture_begin(&r,"new","one",8,now+15000,now));
    assert(!ai_capture_complete(&r,"old","one",8,now));assert(r.pending);
    assert(!ai_capture_complete(&r,"new","one",8,now+15000));
    ai_capture_cancel(&r);
    assert(ai_capture_begin(&r,"last","two",9,now+100,now));
    assert(ai_capture_complete(&r,"last","two",9,now+99));assert(!r.pending);
    assert(!ai_capture_begin(&r,"expired","one",9,now,now));
    /* Serialize and reload the exact production record used by the NVS outbox. */
    ai_observation_t observation={.state=AI_LED_GREEN,.confidence=.93f};
    cJSON *event=ai_build_event_record("event-old","state_changed","one",7,"2026-09-30T00:00:00Z",&observation,"/api/evidence/image.jpg");assert(event);
    char *persisted=cJSON_PrintUnformatted(event);cJSON_Delete(event);assert(persisted);
    int current_configuration_revision=12;(void)current_configuration_revision;
    cJSON *replayed=cJSON_Parse(persisted);assert(replayed);
    assert(cJSON_GetObjectItemCaseSensitive(replayed,"preset_revision")->valueint==7);
    assert(!strcmp(cJSON_GetObjectItemCaseSensitive(replayed,"preset_id")->valuestring,"one"));
    assert(!strcmp(cJSON_GetObjectItemCaseSensitive(replayed,"at")->valuestring,"2026-09-30T00:00:00Z"));
    assert(!strcmp(cJSON_GetObjectItemCaseSensitive(replayed,"evidence_url")->valuestring,"/api/evidence/image.jpg"));
    cJSON_Delete(replayed);free(persisted);
    puts("PASS production capture/event lifecycle: target and revision binding, exact expiry, cancel, stale completion cannot consume new request, historical event serialization/reload retains revision/time/evidence.");return 0;
}
