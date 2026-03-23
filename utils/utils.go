package utils

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-playground/validator/v10"
)

var Validate = validator.New()

func WriteJSON(w http.ResponseWriter, status int, v any) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	return json.NewEncoder(w).Encode(v)
}

func WriteError(w http.ResponseWriter, status int, err error) {
	er := WriteJSON(w, status, map[string]string{"detail": err.Error()})
	if er != nil {
		fmt.Println(er)
	}
}

func Int64(s string) int64 {
	i, _ := strconv.ParseInt(s, 10, 64)
	return i
}
