//go:build !windows

package utils

import (
	"path/filepath"
	"syscall"
)

func GetDiskTotalFree(path string) (uint64, uint64, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(abs, &st); err != nil {
		return 0, 0, err
	}
	total := uint64(st.Blocks) * uint64(st.Bsize)
	free := uint64(st.Bavail) * uint64(st.Bsize)
	return total, free, nil
}
