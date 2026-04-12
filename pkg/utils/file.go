package utils

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/internal/model"
)

var (
	startLayoutRe = regexp.MustCompile(`\{start:([^}]+)\}`)
	endLayoutRe   = regexp.MustCompile(`\{end:([^}]+)\}`)
)

// SanitizeFilename removes illegal characters from filenames across OSes.
func SanitizeFilename(name string) string {
	badChars := []string{"/", "\\", ":", "*", "?", "\"", "<", ">", "|"}
	for _, char := range badChars {
		name = strings.ReplaceAll(name, char, "_")
	}
	return name
}

// RenderFilenameTemplate builds the output filename according to the user's template format.
func RenderFilenameTemplate(tpl string, replay model.BilibiliReplay) string {
	start := time.Unix(replay.StartTime, 0)
	end := time.Unix(replay.EndTime, 0)

	out := tpl
	out = startLayoutRe.ReplaceAllStringFunc(out, func(m string) string {
		sub := startLayoutRe.FindStringSubmatch(m)
		if len(sub) != 2 {
			return m
		}
		return start.Format(sub[1])
	})
	out = endLayoutRe.ReplaceAllStringFunc(out, func(m string) string {
		sub := endLayoutRe.FindStringSubmatch(m)
		if len(sub) != 2 {
			return m
		}
		return end.Format(sub[1])
	})

	out = strings.ReplaceAll(out, "{title}", replay.Title)
	out = strings.ReplaceAll(out, "{live_key}", replay.LiveKey)
	out = strings.ReplaceAll(out, "{yyyy}", fmt.Sprintf("%04d", start.Year()))
	out = strings.ReplaceAll(out, "{yy}", start.Format("06"))
	out = strings.ReplaceAll(out, "{MM}", start.Format("01"))
	out = strings.ReplaceAll(out, "{dd}", start.Format("02"))
	out = strings.ReplaceAll(out, "{start}", start.Format("2006-01-02 15-04-05"))
	out = strings.ReplaceAll(out, "{end}", end.Format("2006-01-02 15-04-05"))
	out = strings.ReplaceAll(out, "{start_unix}", fmt.Sprintf("%d", replay.StartTime))
	out = strings.ReplaceAll(out, "{end_unix}", fmt.Sprintf("%d", replay.EndTime))

	return strings.TrimSpace(out)
}

// BuildFinalPath construct absolute video file path from output dir and template.
func BuildFinalPath(outputDir string, filenameTemplate string, replay model.BilibiliReplay) string {
	name := SanitizeFilename(RenderFilenameTemplate(filenameTemplate, replay))
	if !strings.HasSuffix(strings.ToLower(name), ".mp4") {
		name += ".mp4"
	}
	return filepath.Join(outputDir, name)
}

// UniquePath appends sequence numbers to avoid file overwriting.
func UniquePath(dst string) string {
	if _, err := os.Stat(dst); err != nil {
		return dst
	}
	ext := filepath.Ext(dst)
	base := strings.TrimSuffix(filepath.Base(dst), ext)
	dir := filepath.Dir(dst)
	for i := 1; ; i++ {
		cand := filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
		if _, err := os.Stat(cand); err != nil {
			return cand
		}
	}
}

// MoveFile handles cross-device file renames by falling back to copy then remove.
func MoveFile(src string, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}

	in, err := os.Open(src)
	if err != nil {
		return err
	}

	out, err := os.Create(dst)
	if err != nil {
		in.Close()
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	in.Close() // Explicitly close the source handle before attempting remove

	if copyErr != nil {
		os.Remove(dst)
		return copyErr
	}
	if closeErr != nil {
		os.Remove(dst)
		return closeErr
	}
	
	if err := os.Remove(src); err != nil {
		log.Printf("Warning: File copied successfully but failed to remove original %s: %v", src, err)
	}
	return nil
}

// ResolveReplayFilePath finds the full path. Returns path and a boolean indicating if it was successfully resolved visually or manually checked.
func ResolveReplayFilePath(outputDir string, liveKey string, filePath string) (string, bool) {
	fp := strings.TrimSpace(filePath)
	if fp == "" {
		return FindReplayFileByLiveKey(outputDir, liveKey)
	}

	if _, err := os.Stat(fp); err == nil {
		return fp, true
	}

	if strings.TrimSpace(outputDir) != "" {
		cand := filepath.Join(outputDir, filepath.Base(fp))
		if _, err := os.Stat(cand); err == nil {
			return cand, true
		}
	}

	return FindReplayFileByLiveKey(outputDir, liveKey)
}

// FindReplayFileByLiveKey searches glob patterns based on liveKey inside outputDir.
func FindReplayFileByLiveKey(outputDir string, liveKey string) (string, bool) {
	if strings.TrimSpace(outputDir) == "" || strings.TrimSpace(liveKey) == "" {
		return "", false
	}
	patterns := []string{
		filepath.Join(outputDir, "*"+liveKey+"*.mp4"),
		filepath.Join(outputDir, "*"+liveKey+"*.mkv"),
		filepath.Join(outputDir, "*"+liveKey+"*.flv"),
	}
	for _, pat := range patterns {
		matches, _ := filepath.Glob(pat)
		if len(matches) > 0 {
			return matches[0], true
		}
	}
	return "", false
}

// IsSubpath safely prevents directory traversal outside the parent parameter.
func IsSubpath(parent string, child string) (bool, error) {
	pAbs, err := filepath.Abs(parent)
	if err != nil {
		return false, err
	}
	cAbs, err := filepath.Abs(child)
	if err != nil {
		return false, err
	}
	pAbs = filepath.Clean(pAbs)
	cAbs = filepath.Clean(cAbs)
	if runtime.GOOS == "windows" {
		pAbs = strings.ToLower(pAbs)
		cAbs = strings.ToLower(cAbs)
	}
	if !strings.HasSuffix(pAbs, string(os.PathSeparator)) {
		pAbs += string(os.PathSeparator)
	}
	return strings.HasPrefix(cAbs, pAbs), nil
}
