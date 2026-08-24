//go:build ignore

// Command docscheck mechanically checks that the repository's documentation
// (Readme.md and docs/) hasn't drifted from four sources of truth: the WS
// wire contract (types/websocket.go), REST route registrations under
// internal/ (any .go file, not just ones named routes.go — the WS upgrade
// endpoint, for one, is registered in internal/service/server/handler.go),
// the migrate service's file list in docker-compose.yml vs. sql/init/, and
// the Makefile's target list vs. Readme.md's command table.
//
// Usage:
//
//	go run scripts/docscheck.go [-list] [path]
//
// path defaults to "." (the repo root). -list prints every violation found;
// without it, only per-check and total counts are printed. Exits 1 if any
// violation is found.
//
// Limitation, by design: every check here verifies that something is
// *mentioned* in the right doc file, never that the mention is accurate.
// This catches "forgot to document," not "documented incorrectly."
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

func main() {
	listFlag := flag.Bool("list", false, "print every violation found")
	flag.Parse()

	root := "."
	if flag.NArg() > 0 {
		root = flag.Arg(0)
	}

	total := 0
	total += checkWSContract(root, *listFlag)
	total += checkRESTRoutes(root, *listFlag)
	total += checkMigrations(root, *listFlag)
	total += checkMakeTargets(root, *listFlag)

	fmt.Printf("docscheck: TOTAL violations=%d\n", total)
	if total > 0 {
		os.Exit(1)
	}
}

func readFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "docscheck: %v\n", err)
		os.Exit(2)
	}
	return string(b)
}

// checkWSContract verifies every WsAction*/WsEvent* string value in
// types/websocket.go is mentioned in docs/api.md (or, for values prefixed
// sfu_/voice_, in docs/voice.md instead).
func checkWSContract(root string, list bool) int {
	fset := token.NewFileSet()
	wsPath := filepath.Join(root, "types", "websocket.go")
	file, err := parser.ParseFile(fset, wsPath, nil, parser.ParseComments)
	if err != nil {
		fmt.Fprintf(os.Stderr, "docscheck: parsing %s: %v\n", wsPath, err)
		os.Exit(2)
	}

	apiDoc := readFile(filepath.Join(root, "docs", "api.md"))
	voiceDoc := readFile(filepath.Join(root, "docs", "voice.md"))

	violations := 0
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for i, name := range vs.Names {
				if !strings.HasPrefix(name.Name, "WsAction") && !strings.HasPrefix(name.Name, "WsEvent") {
					continue
				}
				if i >= len(vs.Values) {
					continue
				}
				lit, ok := vs.Values[i].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					continue
				}
				value, err := strconv.Unquote(lit.Value)
				if err != nil {
					continue
				}

				found := strings.Contains(apiDoc, value)
				if !found && (strings.HasPrefix(value, "sfu_") || strings.HasPrefix(value, "voice_")) {
					found = strings.Contains(voiceDoc, value)
				}
				if !found {
					violations++
					if list {
						pos := fset.Position(name.Pos())
						fmt.Printf("%s:%d: %q (%s) not documented in docs/api.md or docs/voice.md\n", pos.Filename, pos.Line, value, name.Name)
					}
				}
			}
		}
	}
	return violations
}

var routeMethodNames = map[string]bool{
	"Get": true, "Post": true, "Put": true, "Patch": true, "Delete": true,
}

// collectRoutes walks node, gathering every literal path passed to a
// *.Get/Post/Put/Patch/Delete(...) call, prefixed by any enclosing
// *.Route("<prefix>", func(router fiber.Router) { ... }) group it's nested
// inside of.
func collectRoutes(node ast.Node, prefix string, out *[]string) {
	ast.Inspect(node, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}

		if routeMethodNames[sel.Sel.Name] {
			if len(call.Args) > 0 {
				if lit, ok := call.Args[0].(*ast.BasicLit); ok && lit.Kind == token.STRING {
					// Path literals always start with "/"; this also happens
					// to exclude fiber.Ctx.Get("Header-Name") calls, which
					// share the method name "Get" but read a request header,
					// not register a route.
					if s, err := strconv.Unquote(lit.Value); err == nil && strings.HasPrefix(s, "/") {
						*out = append(*out, prefix+s)
					}
				}
			}
			return false
		}

		if sel.Sel.Name == "Route" && len(call.Args) >= 2 {
			if lit, ok := call.Args[0].(*ast.BasicLit); ok && lit.Kind == token.STRING {
				if s, err := strconv.Unquote(lit.Value); err == nil && strings.HasPrefix(s, "/") {
					if fn, ok := call.Args[1].(*ast.FuncLit); ok {
						collectRoutes(fn.Body, prefix+s, out)
					}
				}
			}
			return false
		}

		return true
	})
}

// checkRESTRoutes verifies every REST route literal registered under
// internal/ is mentioned in docs/api.md.
func checkRESTRoutes(root string, list bool) int {
	fset := token.NewFileSet()
	apiDoc := readFile(filepath.Join(root, "docs", "api.md"))

	var routes []string
	internalDir := filepath.Join(root, "internal")
	err := filepath.Walk(internalDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, perr := parser.ParseFile(fset, path, nil, 0)
		if perr != nil {
			fmt.Fprintf(os.Stderr, "docscheck: parsing %s: %v\n", path, perr)
			return nil
		}
		collectRoutes(file, "", &routes)
		return nil
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "docscheck: %v\n", err)
		os.Exit(2)
	}

	seen := map[string]bool{}
	violations := 0
	for _, r := range routes {
		if seen[r] {
			continue
		}
		seen[r] = true
		if !strings.Contains(apiDoc, r) {
			violations++
			if list {
				fmt.Printf("route %q not documented in docs/api.md\n", r)
			}
		}
	}
	return violations
}

var migrationFileRE = regexp.MustCompile(`/migrations/([A-Za-z0-9_.-]+\.sql)`)

// checkMigrations verifies sql/init/*.sql matches, as a set, the list of
// files the migrate service's command actually runs in docker-compose.yml.
// This is the one check that catches a real deploy bug, not just an
// undocumented symbol: a file present in sql/init/ but missing from the
// compose command silently never runs against a docker-compose deployment.
func checkMigrations(root string, list bool) int {
	initDir := filepath.Join(root, "sql", "init")
	entries, err := os.ReadDir(initDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "docscheck: %v\n", err)
		os.Exit(2)
	}

	onDisk := map[string]bool{}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			onDisk[e.Name()] = true
		}
	}

	compose := readFile(filepath.Join(root, "docker-compose.yml"))
	inCompose := map[string]bool{}
	for _, m := range migrationFileRE.FindAllStringSubmatch(compose, -1) {
		inCompose[m[1]] = true
	}

	violations := 0
	var names []string
	for n := range onDisk {
		names = append(names, n)
	}
	for n := range inCompose {
		if !onDisk[n] {
			names = append(names, n)
		}
	}
	sort.Strings(names)

	for _, n := range names {
		diskHas, composeHas := onDisk[n], inCompose[n]
		if diskHas && !composeHas {
			violations++
			if list {
				fmt.Printf("sql/init/%s exists but is not run by docker-compose.yml's migrate service\n", n)
			}
		} else if composeHas && !diskHas {
			violations++
			if list {
				fmt.Printf("docker-compose.yml's migrate service runs %s but sql/init/%s does not exist\n", n, n)
			}
		}
	}
	return violations
}

var makeTargetRE = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_-]*):`)

// checkMakeTargets verifies every non-.PHONY Makefile target (except one
// whose rule line ends with a "# internal" comment) is mentioned in
// Readme.md's make-targets table.
func checkMakeTargets(root string, list bool) int {
	makefile := readFile(filepath.Join(root, "Makefile"))
	readme := readFile(filepath.Join(root, "Readme.md"))

	violations := 0
	for _, line := range strings.Split(makefile, "\n") {
		m := makeTargetRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		target := m[1]
		if strings.HasSuffix(strings.TrimSpace(line), "# internal") {
			continue
		}

		mention := "make " + target
		if !strings.Contains(readme, mention) {
			violations++
			if list {
				fmt.Printf("Makefile target %q not documented in Readme.md (expected %q)\n", target, mention)
			}
		}
	}
	return violations
}
