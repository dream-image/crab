//! 将 Chrome 原生 AX 节点压缩成供 AI 阅读的语义树，不执行页面操作。

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wasm_bindgen::prelude::*;

const MAX_OUTPUT_BYTES: usize = 20_000;
const MAX_DEPTH: usize = 10;
const MAX_VISITED_NODES: usize = 50_000;

#[derive(Default, Deserialize)]
struct AxValue {
    #[serde(default)]
    value: Value,
}

#[derive(Deserialize)]
struct AxProperty {
    name: String,
    value: AxValue,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AxNode {
    node_id: String,
    #[serde(default)]
    ignored: bool,
    #[serde(default)]
    role: AxValue,
    #[serde(default)]
    name: AxValue,
    #[serde(default)]
    value: AxValue,
    #[serde(default)]
    properties: Vec<AxProperty>,
    #[serde(default)]
    child_ids: Vec<String>,
    #[serde(rename = "backendDOMNodeId")]
    backend_dom_node_id: Option<i64>,
    #[serde(rename = "ref")]
    reference: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Frame {
    frame_id: String,
    parent_frame_id: Option<String>,
    owner_backend_node_id: Option<i64>,
    name: String,
    url: String,
    nodes: Vec<AxNode>,
    excluded_backend_node_ids: HashSet<i64>,
    protected_backend_node_ids: HashSet<i64>,
}

#[derive(Deserialize)]
struct SnapshotInput {
    frames: Vec<Frame>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompactSnapshot {
    tree: String,
    node_count: usize,
    truncated: bool,
}

struct SemanticNode {
    role: String,
    name: String,
    states: Vec<String>,
    children: Vec<Self>,
    backend_id: Option<i64>,
    reference: Option<String>,
}

fn scalar(value: &AxValue) -> String {
    match &value.value {
        Value::String(text) => text.split_whitespace().collect::<Vec<_>>().join(" "),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        _ => String::new(),
    }
}

fn quoted(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

fn compact_children(nodes: Vec<SemanticNode>) -> Vec<SemanticNode> {
    let mut result: Vec<SemanticNode> = Vec::new();
    for node in nodes {
        if node.role == "text"
            && let Some(previous) = result.last_mut().filter(|last| last.role == "text")
        {
            previous.name.push(' ');
            previous.name.push_str(&node.name);
        } else {
            result.push(node);
        }
    }
    result
}

struct Builder<'a, 'b> {
    frame: &'a Frame,
    nodes: HashMap<&'a str, &'a AxNode>,
    seen: HashSet<&'a str>,
    visited: &'b mut usize,
    truncated: &'b mut bool,
}

impl Builder<'_, '_> {
    fn visit(&mut self, id: &str, depth: usize) -> Vec<SemanticNode> {
        if depth > 128 || *self.visited >= MAX_VISITED_NODES {
            *self.truncated = true;
            return Vec::new();
        }
        let Some(&node) = self.nodes.get(id) else {
            return Vec::new();
        };
        if !self.seen.insert(&node.node_id) {
            return Vec::new();
        }
        *self.visited += 1;
        if node
            .backend_dom_node_id
            .is_some_and(|id| self.frame.excluded_backend_node_ids.contains(&id))
        {
            return Vec::new();
        }
        let role = scalar(&node.role);
        if role == "InlineTextBox" {
            return Vec::new();
        }
        let protected = node
            .backend_dom_node_id
            .is_some_and(|id| self.frame.protected_backend_node_ids.contains(&id));
        let mut children = Vec::new();
        if !protected {
            for child_id in &node.child_ids {
                children.extend(self.visit(child_id, depth + 1));
            }
        }
        let children = compact_children(children);
        if node.ignored
            || matches!(
                role.as_str(),
                "RootWebArea" | "generic" | "none" | "presentation"
            )
        {
            return children;
        }
        let mut semantic = SemanticNode {
            role: if role == "StaticText" {
                "text".to_owned()
            } else {
                role
            },
            name: scalar(&node.name),
            states: Vec::new(),
            children,
            backend_id: node.backend_dom_node_id,
            reference: node.reference.clone(),
        };
        if protected {
            semantic.states.push("protected".to_owned());
        }
        for property in &node.properties {
            let value = scalar(&property.value);
            if value.is_empty() {
                continue;
            }
            match property.name.as_str() {
                "checked" | "expanded" | "pressed" | "selected" | "level" | "valuemin"
                | "valuemax" | "valuetext" => {
                    semantic
                        .states
                        .push(format!("{}={}", property.name, quoted(&value)));
                }
                "disabled" | "required" | "readonly" | "multiselectable" | "modal"
                    if value == "true" =>
                {
                    semantic.states.push(property.name.clone());
                }
                _ => {}
            }
        }
        let value = scalar(&node.value);
        if !protected && !value.is_empty() && value != semantic.name {
            semantic.states.push(format!("value={}", quoted(&value)));
        }
        if semantic.children.len() == 1
            && semantic.children[0].role == "text"
            && semantic.children[0].name == semantic.name
        {
            semantic.children.clear();
        }
        if semantic.name.is_empty()
            && semantic.reference.is_none()
            && semantic.states.is_empty()
            && semantic.children.is_empty()
            && !matches!(
                semantic.role.as_str(),
                "button" | "link" | "textbox" | "combobox" | "checkbox" | "radio" | "slider"
            )
        {
            return Vec::new();
        }
        vec![semantic]
    }
}

fn attach_frame(
    nodes: &mut [SemanticNode],
    backend_id: i64,
    children: &mut Vec<SemanticNode>,
) -> bool {
    for node in nodes {
        if node.backend_id == Some(backend_id) {
            node.children.append(children);
            return true;
        }
        if attach_frame(&mut node.children, backend_id, children) {
            return true;
        }
    }
    false
}

fn build_frame(
    input: &SnapshotInput,
    frame: &Frame,
    depth: usize,
    visited: &mut usize,
    truncated: &mut bool,
) -> Vec<SemanticNode> {
    if depth > 16 {
        *truncated = true;
        return Vec::new();
    }
    let mut builder = Builder {
        frame,
        nodes: frame
            .nodes
            .iter()
            .map(|node| (node.node_id.as_str(), node))
            .collect(),
        seen: HashSet::new(),
        visited,
        truncated,
    };
    let mut nodes = frame
        .nodes
        .first()
        .map(|root| builder.visit(&root.node_id, 0))
        .unwrap_or_default();
    for child in input
        .frames
        .iter()
        .filter(|child| child.parent_frame_id.as_deref() == Some(&frame.frame_id))
    {
        let mut children = build_frame(input, child, depth + 1, visited, truncated);
        if children.is_empty() {
            continue;
        }
        if child
            .owner_backend_node_id
            .is_some_and(|id| attach_frame(&mut nodes, id, &mut children))
        {
            continue;
        }
        nodes.push(SemanticNode {
            role: "iframe".to_owned(),
            name: if child.name.is_empty() {
                child.url.clone()
            } else {
                child.name.clone()
            },
            states: Vec::new(),
            children,
            backend_id: None,
            reference: None,
        });
    }
    nodes
}

impl CompactSnapshot {
    fn append(&mut self, node: &SemanticNode, depth: usize) {
        if depth > MAX_DEPTH {
            self.truncated = true;
            return;
        }
        let prefix = format!("{}- {}", "  ".repeat(depth), node.role);
        let name = if node.name.is_empty() {
            String::new()
        } else {
            format!(" {}", quoted(&node.name))
        };
        let mut states = node
            .states
            .iter()
            .map(|state| format!(" [{state}]"))
            .collect::<String>();
        if let Some(reference) = &node.reference {
            states.push_str(&format!(" [ref={reference}]"));
        }
        let line = format!("{prefix}{name}{states}\n");
        if self.tree.len() + line.len() > MAX_OUTPUT_BYTES {
            self.truncated = true;
            let available = MAX_OUTPUT_BYTES.saturating_sub(self.tree.len() + prefix.len() + 20);
            if available > 6 {
                let shortened = node.name.chars().take(available / 6).collect::<String>();
                self.tree
                    .push_str(&format!("{prefix} {} [truncated]\n", quoted(&shortened)));
                self.node_count += 1;
            }
            return;
        }
        self.tree.push_str(&line);
        self.node_count += 1;
        for child in &node.children {
            self.append(child, depth + 1);
        }
    }
}

/// 接收按 frame 分组的 CDP AX 节点，返回紧凑树及截断信息；协议错误通过 JS 异常返回。
#[wasm_bindgen]
pub fn compact_snapshot(input: &str) -> Result<String, JsError> {
    let input: SnapshotInput =
        serde_json::from_str(input).map_err(|error| JsError::new(&error.to_string()))?;
    let mut result = CompactSnapshot {
        tree: String::new(),
        node_count: 0,
        truncated: false,
    };
    let mut visited = 0;
    for frame in input
        .frames
        .iter()
        .filter(|frame| frame.parent_frame_id.is_none())
    {
        let nodes = build_frame(&input, frame, 0, &mut visited, &mut result.truncated);
        for node in compact_children(nodes) {
            result.append(&node, 0);
        }
    }
    serde_json::to_string(&result).map_err(|error| JsError::new(&error.to_string()))
}
