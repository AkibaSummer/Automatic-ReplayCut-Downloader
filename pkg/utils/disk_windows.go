//go:build windows

package utils

import (
	"path/filepath"

	"golang.org/x/sys/windows"
)

func GetDiskTotalFree(path string) (uint64, uint64, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	p, err := windows.UTF16PtrFromString(abs)
	if err != nil {
		return 0, 0, err
	}
	var freeBytesAvailable uint64
	var totalNumberOfBytes uint64
	var totalNumberOfFreeBytes uint64
	if err := windows.GetDiskFreeSpaceEx(p, &freeBytesAvailable, &totalNumberOfBytes, &totalNumberOfFreeBytes); err != nil {
		return 0, 0, err
	}
	return totalNumberOfBytes, totalNumberOfFreeBytes, nil
}
