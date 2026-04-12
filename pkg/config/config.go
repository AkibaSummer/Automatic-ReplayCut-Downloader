package config

import (
	"os"
	"strings"

	"github.com/spf13/viper"
	"go.yaml.in/yaml/v3"
)

type Config struct {
	Bilibili struct {
		AnchorID   int               `mapstructure:"anchor_id" json:"anchor_id" yaml:"anchor_id"`
		Cookies    map[string]string `mapstructure:"cookies" json:"cookies" yaml:"cookies"`
		CookieFile string            `mapstructure:"cookie_file" json:"cookie_file" yaml:"cookie_file"`
	} `mapstructure:"bilibili" json:"bilibili" yaml:"bilibili"`
	Download struct {
		OutputDir          string `mapstructure:"output_dir" json:"output_dir" yaml:"output_dir"`
		TempDir            string `mapstructure:"temp_dir" json:"temp_dir" yaml:"temp_dir"`
		FilenameTemplate   string `mapstructure:"filename_template" json:"filename_template" yaml:"filename_template"`
		MaxConcurrentTasks int    `mapstructure:"max_concurrent_tasks" json:"max_concurrent_tasks" yaml:"max_concurrent_tasks"`
		ConcurrentSegments int    `mapstructure:"concurrent_segments" json:"concurrent_segments" yaml:"concurrent_segments"`
	} `mapstructure:"download" json:"download" yaml:"download"`
	Database struct {
		DSN string `mapstructure:"dsn" json:"dsn" yaml:"dsn"`
	} `mapstructure:"database" json:"database" yaml:"database"`
	Server struct {
		Port int `mapstructure:"port" json:"port" yaml:"port"`
	} `mapstructure:"server" json:"server" yaml:"server"`
}

func LoadConfig() (*Config, error) {
	viper.SetConfigName("config")
	viper.SetConfigType("yaml")
	viper.AddConfigPath(".")
	viper.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	viper.AutomaticEnv()

	// Default values
	viper.SetDefault("database.dsn", "replays.db")
	viper.SetDefault("server.port", 8081)
	viper.SetDefault("download.filename_template", "{yy}-{MM}-{dd} {start:150405} {title}.mp4")
	viper.SetDefault("download.max_concurrent_tasks", 2)
	viper.SetDefault("download.concurrent_segments", 5)

	if err := viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, err
		}
	}

	normalizeLegacyKeys()

	var config Config
	if err := viper.Unmarshal(&config); err != nil {
		return nil, err
	}

	return &config, nil
}

func (c *Config) Save() error {
	b, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile("config.yaml", b, 0644)
}

func normalizeLegacyKeys() {
	if !viper.IsSet("bilibili.anchor_id") && viper.IsSet("bilibili.anchorid") {
		viper.Set("bilibili.anchor_id", viper.GetInt("bilibili.anchorid"))
	}
	if !viper.IsSet("bilibili.cookie_file") && viper.IsSet("bilibili.cookiefile") {
		viper.Set("bilibili.cookie_file", viper.GetString("bilibili.cookiefile"))
	}
	if !viper.IsSet("download.output_dir") && viper.IsSet("download.outputdir") {
		viper.Set("download.output_dir", viper.GetString("download.outputdir"))
	}
	if !viper.IsSet("download.temp_dir") && viper.IsSet("download.tempdir") {
		viper.Set("download.temp_dir", viper.GetString("download.tempdir"))
	}
	if !viper.IsSet("download.filename_template") && viper.IsSet("download.filenametemplate") {
		viper.Set("download.filename_template", viper.GetString("download.filenametemplate"))
	}
	if !viper.IsSet("download.max_concurrent_tasks") && viper.IsSet("download.maxconcurrenttasks") {
		viper.Set("download.max_concurrent_tasks", viper.GetInt("download.maxconcurrenttasks"))
	}
	if !viper.IsSet("download.concurrent_segments") && viper.IsSet("download.concurrentsegments") {
		viper.Set("download.concurrent_segments", viper.GetInt("download.concurrentsegments"))
	}
}
