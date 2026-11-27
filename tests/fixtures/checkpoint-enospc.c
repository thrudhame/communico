#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/uio.h>
#include <unistd.h>

/* Fault only native writes to one designated fd path, only while armed. */
static int fail(int fd, const char *operation) {
    const char *target = getenv("CHECKPOINT_FAULT_PATH");
    const char *kind = getenv("CHECKPOINT_FAULT_OPERATION");
    const char *arm = getenv("CHECKPOINT_FAULT_ARM");
    if (!target || !kind || !arm || strcmp(kind, operation)) return 0;

    const int saved = errno;
    char fdpath[64], path[PATH_MAX];
    snprintf(fdpath, sizeof fdpath, "/proc/self/fd/%d", fd);
    ssize_t size = readlink(fdpath, path, sizeof path - 1);
    if (size >= 0) {
        path[size] = '\0';
        if (!strcmp(path, target) && access(arm, F_OK) == 0) {
            fprintf(stderr, "injected ENOSPC: %s %s\n", operation, path);
            errno = ENOSPC;
            return 1;
        }
    }
    errno = saved;
    return 0;
}

#define WRITE(name, offset) \
ssize_t name(int fd, const void *data, size_t size, offset pos) { \
    if (fail(fd, "pwrite")) return -1; \
    ssize_t (*next)(int, const void *, size_t, offset) = dlsym(RTLD_NEXT, #name); \
    return next(fd, data, size, pos); \
}

#define WRITEV(name, offset) \
ssize_t name(int fd, const struct iovec *vec, int count, offset pos) { \
    if (fail(fd, "pwritev")) return -1; \
    ssize_t (*next)(int, const struct iovec *, int, offset) = dlsym(RTLD_NEXT, #name); \
    return next(fd, vec, count, pos); \
}

WRITE(pwrite, off_t)
WRITE(pwrite64, off64_t)
WRITEV(pwritev, off_t)
WRITEV(pwritev64, off64_t)
