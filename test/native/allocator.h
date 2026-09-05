#ifndef SWM_TEST_ALLOCATOR_H
#define SWM_TEST_ALLOCATOR_H

#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
void *swm_test_malloc(size_t size);
void *swm_test_calloc(size_t count, size_t size);
void *swm_test_realloc(void *pointer, size_t size);
void swm_test_free(void *pointer);
#ifdef __cplusplus
}
#endif
#endif
